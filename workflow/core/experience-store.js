/**
 * Experience Store – Persistent experience accumulation across sessions
 *
 * Refactored into focused modules:
 *   - experience-types.js     – ExperienceType, ExperienceCategory, category constants
 *   - experience-query.js     – Search, keyword extraction, LLM query expansion, synonym table
 *   - experience-evolution.js – Hit tracking, adaptive thresholds, evolution triggers
 *   - experience-transfer.js  – Cross-project export/import
 *   - experience-store.js     – Core storage (this file), constructor, CRUD, mixin assembly
 *
 * All external consumers continue to require('./experience-store') – the public API is unchanged.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, EXPERIENCE } = require('./constants');
const { ExperienceType, ExperienceCategory, UNIVERSAL_CATEGORIES, KnowledgeLayer, getLayerForCategory } = require('./experience-types');
const { extractKeywords, ExperienceQueryMixin, STOPWORDS, SHORT_WORD_WHITELIST, ExperienceDeduplicator, computeExperienceSimilarity } = require('./experience-query');
const { ExperienceEvolutionMixin } = require('./experience-evolution');
const { ExperienceTransferMixin } = require('./experience-transfer');
const { ExperienceDistillationMixin } = require('./experience-distillation');
const { ExperienceAbstractionMixin } = require('./experience-abstraction-mixin');
const { ExperienceHealthMixin } = require('./experience-health-mixin');
const { introspectionCollector } = require('./workflow-introspection-collector');
const { getGlobalEventBus, ExperienceEvents } = require('./experience-event-bus');

// ─── Experience Store ─────────────────────────────────────────────────────────

class ExperienceStore {
  /**
   * @param {string} [storePath] - Path to persist experience JSON
   */
  constructor(storePath = null) {
    this.storePath = storePath || path.join(PATHS.OUTPUT_DIR, 'experiences.json');
    /** @type {Experience[]} */
    this.experiences = [];
    this._dirty = false;
    /** @type {Set<string>} */
    this._titleIndex = new Set();
    /** @type {Map<string, Experience>} O(1) lookup by ID (A-3 architecture fix) */
    this._idIndex = new Map();

    // P4a fix: Multi-dimensional index system for efficient queries (O(1) lookup)
    /** @type {Map<string, Set<string>>} Skill → Experience IDs inverted index */
    this._skillIndex = new Map();
    /** @type {Map<string, Set<string>>} Category → Experience IDs inverted index */
    this._categoryIndex = new Map();
    /** @type {Map<string, Set<string>>} Tag → Experience IDs inverted index */
    this._tagIndex = new Map();
    /** @type {Map<string, Set<string>>} Knowledge Layer → Experience IDs (ADR-43) */
    this._layerIndex = new Map();
    /** @type {Map<string, Set<string>>} Keyword → Experience IDs inverted index */
    this._keywordIndex = new Map();

    /** @type {object|null} */
    this._complaintWall = null;
    /** @type {Function|null} */
    this._llmCall = null;

    // Synonym table (managed by ExperienceQueryMixin)
    this._synonymTable = {};
    this._synonymTablePath = path.join(path.dirname(this.storePath), 'synonym-table.json');
    this._synonymTableDirty = false;
    this._loadSynonymTable();

    // Content deduplication (P1 enhancement)
    this._contentDeduplicator = new ExperienceDeduplicator({
      similarityThreshold: 0.75,
      clusterThreshold: 0.50,
      useMinHash: true,
    });

    // P4a fix: Query cache for frequently accessed searches
    /** @type {Map<string, {results: Experience[], timestamp: number}>} */
    this._queryCache = new Map();
    this._queryCacheMaxSize = 1000;
    this._queryCacheTTL = 60000; // 60 seconds

    // Event-Driven: Initialize event bus reference
    this._eventBus = getGlobalEventBus();

    this._load();
  }

  /**
   * Register event handlers for this store instance.
   * Call this after creating the store to wire up event-driven processing.
   *
   * @param {SkillEvolution} [skillEvolution] – Optional skill evolution instance
   * @param {object} [options] – Handler options
   * @returns {Function} Unregister function
   */
  registerEventHandlers(skillEvolution, options = {}) {
    const { registerExperienceEventHandlers } = require('./experience-event-handlers');
    this._unregisterHandlers = registerExperienceEventHandlers(this, skillEvolution, options);
    return this._unregisterHandlers;
  }

  /**
   * Unregister all event handlers.
   * Call this before disposing the store to prevent memory leaks.
   */
  unregisterEventHandlers() {
    if (this._unregisterHandlers) {
      this._unregisterHandlers();
      this._unregisterHandlers = null;
    }
  }

  // ─── Core Storage API ─────────────────────────────────────────────────────

  /**
   * Records a new experience.
   *
   * @param {object} options
   * @param {string}   options.type       - ExperienceType.POSITIVE or NEGATIVE
   * @param {string}   options.category   - ExperienceCategory value
   * @param {string}   options.title      - Short summary (one line)
   * @param {string}   options.content    - Detailed description with context
   * @param {string}   [options.taskId]   - Source task ID
   * @param {string}   [options.skill]    - Related skill name
   * @param {string[]} [options.tags]     - Searchable tags
   * @param {string}   [options.codeExample] - Code snippet
   * @returns {Experience}
   */
  record(options) {
    const { type, category, title, content, taskId = null, skill = null, tags = [], codeExample = null } = options;
    const id = `EXP-${Date.now()}-${Math.random().toString(36).slice(2, 9).toUpperCase()}`;
    const ttlDays = options.ttlDays !== undefined
      ? options.ttlDays
      : (type === ExperienceType.NEGATIVE ? 90 : 365);
    const expiresAt = ttlDays != null
      ? new Date(Date.now() + ttlDays * 86400_000).toISOString()
      : null;
    const exp = {
      id, type, category, title, content, taskId, skill, tags, codeExample,
      sourceFile: options.sourceFile || null,
      namespace: options.namespace || null,
      moduleId: options.moduleId || null,
      hitCount: 0,
      evolutionCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt,
    };
    this.experiences.push(exp);
    this._titleIndex.add(exp.title);
    this._idIndex.set(exp.id, exp);

    // P4a fix: Update multi-dimensional indexes for O(1) lookups
    this._updateMultiIndex(exp);

    // Introspection logging
    introspectionCollector.recordExperience('registered', {
      experienceId: exp.id,
      type: exp.type,
      category: exp.category,
      title: exp.title,
      sourceFile: exp.sourceFile,
    });

    // Defect F fix: auto-file complaint from negative experience
    if (exp.type === ExperienceType.NEGATIVE && this._complaintWall) {
      try {
        this._complaintWall.fileFromNegativeExperience(exp);
      } catch (err) {
        console.warn(`[ExperienceStore] ⚠️  Failed to file complaint from negative experience: ${err.message}`);
      }
    }
    this._save();

    // Event-Driven: Publish EXPERIENCE_RECORDED event for decoupled processing
    // This replaces direct calls to evolution, distillation, and abstraction modules
    const eventBus = getGlobalEventBus();
    eventBus.emit(ExperienceEvents.EXPERIENCE_RECORDED, {
      experience: exp,
      store: this,
      timestamp: exp.createdAt,
    });

    // Event-Driven: Check capacity and publish warning if needed
    const { EXPERIENCE } = require('./constants');
    if (this.experiences.length >= EXPERIENCE.MAX_CAPACITY * 0.8) {
      eventBus.emit(ExperienceEvents.CAPACITY_WARNING, {
        count: this.experiences.length,
        threshold: EXPERIENCE.MAX_CAPACITY,
        ratio: this.experiences.length / EXPERIENCE.MAX_CAPACITY,
      });
    }

    return exp;
  }

  /**
   * Checks if an experience with the same title already exists.
   *
   * @param {string} title
   * @returns {Experience|null}
   */
  findByTitle(title) {
    return this.experiences.find(e => e.title === title) || null;
  }

  /**
   * Finds experiences with similar content using content-based similarity.
   * P1 enhancement: Detects duplicates even with different titles.
   *
   * @param {object} options
   * @param {string} options.title - Experience title
   * @param {string} options.content - Experience content
   * @param {string} [options.type] - Optional type filter
   * @param {string} [options.category] - Optional category filter
   * @param {number} [similarityThreshold=0.70] - Minimum similarity score
   * @returns {Array<{exp: Experience, similarity: number}>} Sorted by similarity desc
   */
  findSimilarByContent({ title, content, type, category }, similarityThreshold = 0.70) {
    if (!title && !content) return [];

    const candidates = this.experiences.filter(e => {
      if (type && e.type !== type) return false;
      if (category && e.category !== category) return false;
      return true;
    });

    const queryExp = { title: title || '', content: content || '' };
    const results = [];

    for (const exp of candidates) {
      const similarity = computeExperienceSimilarity(queryExp, exp, {
        titleWeight: 0.3,
        contentWeight: 0.7,
        useMinHash: true,
      });

      if (similarity >= similarityThreshold) {
        results.push({ exp, similarity });
      }
    }

    return results.sort((a, b) => b.similarity - a.similarity);
  }

  /**
   * Records a new experience with content-based duplicate detection.
   * If similar content exists, appends to existing instead of creating new.
   *
   * @param {object} options - Same as record()
   * @param {number} [similarityThreshold=0.75] - Threshold for considering as duplicate
   * @returns {Experience} New or updated experience
   */
  recordWithContentCheck(options, similarityThreshold = 0.75) {
    const { type, category, title, content } = options;

    // First check title-based duplicate
    const titleDup = this.findByTitle(title);
    if (titleDup) {
      return this.appendByTitle(title, content) || titleDup;
    }

    // Then check content-based similarity
    const similar = this.findSimilarByContent(
      { title, content, type, category },
      similarityThreshold
    );

    if (similar.length > 0) {
      const bestMatch = similar[0];
      console.log(`[ExperienceStore] 📎 Content similarity detected (${(bestMatch.similarity * 100).toFixed(1)}%): "${title}" → "${bestMatch.exp.title}"`);
      return this.appendByTitle(bestMatch.exp.title, content) || bestMatch.exp;
    }

    // No match found, create new
    return this.record(options);
  }

  /**
   * Analyzes the experience store for duplicate content.
   * Returns clusters of similar experiences for review.
   *
   * @param {object} [options] - Analysis options
   * @param {number} [options.similarityThreshold=0.70] - Similarity threshold for clustering
   * @returns {object} Analysis results with clusters and merge suggestions
   */
  analyzeContentDuplicates(options = {}) {
    const { similarityThreshold = 0.70 } = options;

    // Reconfigure deduplicator with custom threshold
    const analyzer = new ExperienceDeduplicator({
      similarityThreshold,
      clusterThreshold: similarityThreshold,
      useMinHash: true,
    });

    const clusters = analyzer.cluster(this.experiences);
    const duplicates = analyzer.findDuplicates(this.experiences);
    const suggestions = analyzer.suggestMerges(this.experiences);

    return {
      totalExperiences: this.experiences.length,
      clusters: clusters.filter(c => c.members.length > 1),
      duplicateGroups: duplicates,
      mergeSuggestions: suggestions.slice(0, 20), // Top 20 suggestions
      stats: {
        clusteredCount: clusters.filter(c => c.members.length > 1)
          .reduce((sum, c) => sum + c.members.length, 0),
        duplicateCount: duplicates.reduce((sum, g) => sum + g.duplicates.length, 0),
        potentialSavings: suggestions.reduce((sum, s) => sum + (s.memberCount - 1), 0),
      },
    };
  }

  /**
   * Merges duplicate experiences into one.
   *
   * @param {string} primaryId - ID of the experience to keep
   * @param {string[]} duplicateIds - IDs of experiences to merge and remove
   * @returns {Experience|null} Updated primary experience
   */
  mergeDuplicates(primaryId, duplicateIds) {
    const primary = this._idIndex.get(primaryId);
    if (!primary) return null;

    for (const dupId of duplicateIds) {
      const dup = this._idIndex.get(dupId);
      if (!dup || dup.id === primary.id) continue;

      // Append duplicate content
      if (dup.content && !primary.content.includes(dup.content.slice(0, 100))) {
        if (!primary.updates) primary.updates = [];
        primary.updates.push({
          date: new Date().toISOString().slice(0, 10),
          content: `[Merged from ${dup.id}] ${dup.content}`,
          source: 'merge',
        });
        primary.content += `\n\n[Merged from ${dup.id}] ${dup.content}`;
      }

      // Merge tags
      if (dup.tags) {
        const existingTags = new Set(primary.tags || []);
        for (const tag of dup.tags) {
          if (!existingTags.has(tag)) {
            if (!primary.tags) primary.tags = [];
            primary.tags.push(tag);
            existingTags.add(tag);
          }
        }
      }

      // Merge hit counts
      primary.hitCount = (primary.hitCount || 0) + (dup.hitCount || 0);

      // Mark as merged
      this._idIndex.delete(dup.id);
      const idx = this.experiences.findIndex(e => e.id === dup.id);
      if (idx >= 0) this.experiences.splice(idx, 1);
    }

    primary.updatedAt = new Date().toISOString();
    this._save();
    this._contentDeduplicator.clearCache();

    return primary;
  }

  /**
   * Updates an existing experience by appending new content.
   *
   * @param {string} title
   * @param {string} additionalContent
   * @returns {Experience|null}
   */
  appendByTitle(title, additionalContent) {
    const exp = this.findByTitle(title);
    if (!exp) return null;
    // N40 fix: 120-char prefix dedup check
    if (exp.content.includes(additionalContent.slice(0, 120))) return exp;

    if (!exp.updates) exp.updates = [];
    exp.updates.push({
      date: new Date().toISOString().slice(0, 10),
      content: additionalContent,
    });
    exp.content = `${exp.content}\n\n[Update ${new Date().toISOString().slice(0, 10)}] ${additionalContent}`;
    exp.updatedAt = new Date().toISOString();
    this._save();
    return exp;
  }

  /**
   * Atomically records if absent (dedup by title).
   *
   * @param {string} title
   * @param {object} options - Same as record()
   * @returns {Experience|null}
   */
  recordIfAbsent(title, options) {
    if (this._titleIndex.has(title)) return null;
    if (this.findByTitle(title)) {
      this._titleIndex.add(title);
      return null;
    }
    this._titleIndex.add(title);
    return this.record(options);
  }

  /**
   * Batch-records multiple experiences, skipping duplicates.
   *
   * @param {object[]} items
   * @returns {{ added: number, skipped: number }}
   */
  batchRecord(items) {
    let added = 0;
    let skipped = 0;
    let batchSeq = 0;
    for (const item of items) {
      if (this._titleIndex.has(item.title) || this.findByTitle(item.title)) {
        this._titleIndex.add(item.title);
        skipped++;
        continue;
      }
      this._titleIndex.add(item.title);
      const { type, category, title, content, taskId = null, skill = null, tags = [], codeExample = null } = item;
      const id = `EXP-${Date.now()}-${String(batchSeq++).padStart(4, '0')}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
      const ttlDays = item.ttlDays !== undefined
        ? item.ttlDays
        : (type === ExperienceType.NEGATIVE ? 90 : 365);
      const expiresAt = ttlDays != null
        ? new Date(Date.now() + ttlDays * 86400_000).toISOString()
        : null;
      const exp = {
        id, type, category, title, content, taskId, skill, tags, codeExample,
        sourceFile: item.sourceFile || null,
        namespace: item.namespace || null,
        moduleId: item.moduleId || null,
        hitCount: 0, evolutionCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt,
      };
      this.experiences.push(exp);
      this._idIndex.set(id, exp);
      added++;
    }
    if (added > 0) this._save();
    return { added, skipped };
  }

  /**
   * Purges all expired experiences.
   *
   * @returns {{ purged: number, remaining: number }}
   */
  purgeExpired() {
    const now = Date.now();
    const before = this.experiences.length;
    this.experiences = this.experiences.filter(e => !e.expiresAt || new Date(e.expiresAt).getTime() > now);
    const purged = before - this.experiences.length;
    if (purged > 0) {
      // P4a fix: Rebuild all indexes after bulk removal
      this._rebuildAllIndexes();
      this._save();
      console.log(`[ExperienceStore] Purged ${purged} expired experience(s). Remaining: ${this.experiences.length}`);
    }
    return { purged, remaining: this.experiences.length };
  }

  /**
   * Returns all experiences in the store.
   * Used by AEF Self-Refinement analysis to scan for negative experience patterns.
   *
   * @returns {Experience[]}
   */
  getAll() {
    return this.experiences;
  }

  /**
   * Returns statistics about the experience store.
   */
  getStats() {
    const positive = this.experiences.filter(e => e.type === ExperienceType.POSITIVE).length;
    const negative = this.experiences.filter(e => e.type === ExperienceType.NEGATIVE).length;
    const totalEvolutions = this.experiences.reduce((sum, e) => sum + e.evolutionCount, 0);
    const byCategory = {};
    for (const exp of this.experiences) {
      byCategory[exp.category] = (byCategory[exp.category] || 0) + 1;
    }
    return { total: this.experiences.length, positive, negative, totalEvolutions, byCategory };
  }

  // ─── ADR-43: Knowledge Layer Methods ─────────────────────────────────────

  /**
   * Get experiences filtered by knowledge layer.
   * ADR-43: Enables layer-aware experience retrieval.
   *
   * @param {string} layer - KnowledgeLayer value (PLATFORM, DOMAIN, PRACTICE)
   * @returns {Experience[]}
   */
  getByLayer(layer) {
    return this.experiences.filter(exp => {
      const expLayer = getLayerForCategory(exp.category);
      return expLayer === layer;
    });
  }

  /**
   * Get statistics grouped by knowledge layer.
   * Useful for understanding the composition of the experience store.
   *
   * @returns {{ byLayer: object, practiceRatio: number }}
   */
  getLayerStats() {
    const byLayer = {
      [KnowledgeLayer.PLATFORM]: 0,
      [KnowledgeLayer.DOMAIN]: 0,
      [KnowledgeLayer.PRACTICE]: 0,
    };

    for (const exp of this.experiences) {
      const layer = getLayerForCategory(exp.category);
      byLayer[layer] = (byLayer[layer] || 0) + 1;
    }

    const total = this.experiences.length;
    const practiceRatio = total > 0 ? byLayer[KnowledgeLayer.PRACTICE] / total : 0;

    return { byLayer, practiceRatio, total };
  }

  /**
   * Check if the experience store has too many non-PRACTICE layer experiences.
   * ADR-43: Quality gate to prevent experience store pollution.
   *
   * @param {number} [threshold=0.5] - Minimum PRACTICE ratio threshold
   * @returns {{ healthy: boolean, practiceRatio: number, recommendation: string }}
   */
  checkLayerHealth(threshold = 0.5) {
    const { byLayer, practiceRatio, total } = this.getLayerStats();

    if (total < 10) {
      return {
        healthy: true,
        practiceRatio,
        recommendation: 'Not enough experiences to assess layer health',
      };
    }

    const healthy = practiceRatio >= threshold;
    let recommendation = '';

    if (!healthy) {
      const nonPractice = byLayer[KnowledgeLayer.PLATFORM] + byLayer[KnowledgeLayer.DOMAIN];
      recommendation = `PRACTICE layer ratio (${(practiceRatio * 100).toFixed(1)}%) below threshold (${(threshold * 100)}%). ` +
        `Consider purging ${nonPractice} PLATFORM/DOMAIN experiences or capturing more PRACTICE experiences.`;
    } else {
      recommendation = `Layer health is good: ${(practiceRatio * 100).toFixed(1)}% PRACTICE experiences`;
    }

    return { healthy, practiceRatio, recommendation, byLayer };
  }

  /**
   * Sets the ComplaintWall reference for bidirectional sync.
   *
   * @param {object} complaintWall
   */
  setComplaintWall(complaintWall) {
    this._complaintWall = complaintWall;
  }

  // ─── Private: Persistence ─────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        this.experiences = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        this._titleIndex = new Set(this.experiences.map(e => e.title));
        this._rebuildIdIndex();
        console.log(`[ExperienceStore] Loaded ${this.experiences.length} experiences`);

        // P2-1 fix: auto-purge expired on load
        const now = Date.now();
        const beforePurge = this.experiences.length;
        this.experiences = this.experiences.filter(
          e => !e.expiresAt || new Date(e.expiresAt).getTime() > now
        );
        const purged = beforePurge - this.experiences.length;
        if (purged > 0) {
          this._titleIndex = new Set(this.experiences.map(e => e.title));
          this._rebuildIdIndex();
          console.log(`[ExperienceStore] Auto-purged ${purged} expired experience(s) on load. Remaining: ${this.experiences.length}`);
        }

        // P2-C: Auto-distill similar experiences before capacity eviction.
        // This preserves knowledge by merging instead of blindly evicting.
        if (typeof this.autoDistill === 'function') {
          this.autoDistill();
        }

        // P4a fix: enforce capacity cap using value-density based eviction
        // Computes composite value score considering hit count, recency, evolution count, and knowledge layer
        const MAX_CAPACITY = EXPERIENCE.MAX_CAPACITY;
        if (this.experiences.length > MAX_CAPACITY) {
          const toEvict = this._evictByValueDensity(MAX_CAPACITY);
          console.log(`[ExperienceStore] Capacity cap enforced: evicted ${toEvict} low-value experience(s). Remaining: ${this.experiences.length}`);
          this._save();
        }
      }
    } catch (err) {
      console.warn(`[ExperienceStore] Could not load experiences: ${err.message}`);
    }
  }

  /**
   * Rebuilds the _idIndex Map from the current experiences array.
   * Called after any operation that mutates the experiences array (load, purge, eviction).
   * A-3 architecture fix: enables O(1) lookup by experience ID across all Mixins.
   */
  _rebuildIdIndex() {
    this._idIndex = new Map();
    for (const exp of this.experiences) {
      this._idIndex.set(exp.id, exp);
    }
  }

  // ─── P4a: Multi-dimensional Index Management ─────────────────────────────

  /**
   * Updates all multi-dimensional indexes when an experience is added.
   * Enables O(1) lookup by skill, category, tag, layer, and keywords.
   *
   * @param {Experience} exp
   * @private
   */
  _updateMultiIndex(exp) {
    // Skill index
    if (exp.skill) {
      this._addToIndex(this._skillIndex, exp.skill, exp.id);
    }

    // Category index
    if (exp.category) {
      this._addToIndex(this._categoryIndex, exp.category, exp.id);
    }

    // Tag index (each tag → exp ID)
    if (exp.tags && exp.tags.length > 0) {
      for (const tag of exp.tags) {
        this._addToIndex(this._tagIndex, tag.toLowerCase(), exp.id);
      }
    }

    // Layer index (ADR-43)
    const layer = getLayerForCategory(exp.category);
    this._addToIndex(this._layerIndex, layer, exp.id);

    // Keyword index (extract from title + content)
    const keywords = this._extractIndexKeywords(exp);
    for (const kw of keywords) {
      this._addToIndex(this._keywordIndex, kw, exp.id);
    }
  }

  /**
   * Adds an entry to an inverted index (Map<string, Set<string>>).
   *
   * @param {Map<string, Set<string>>} index
   * @param {string} key
   * @param {string} expId
   * @private
   */
  _addToIndex(index, key, expId) {
    if (!index.has(key)) {
      index.set(key, new Set());
    }
    index.get(key).add(expId);
  }

  /**
   * Removes an entry from an inverted index.
   *
   * @param {Map<string, Set<string>>} index
   * @param {string} key
   * @param {string} expId
   * @private
   */
  _removeFromIndex(index, key, expId) {
    if (!index.has(key)) return;
    index.get(key).delete(expId);
    if (index.get(key).size === 0) {
      index.delete(key);
    }
  }

  /**
   * Extracts keywords from experience for the keyword index.
   * Uses title and first 200 chars of content.
   *
   * @param {Experience} exp
   * @returns {string[]}
   * @private
   */
  _extractIndexKeywords(exp) {
    const text = `${exp.title} ${(exp.content || '').slice(0, 200)}`.toLowerCase();
    const words = text
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOPWORDS.has(w));
    return [...new Set(words)].slice(0, 10); // Deduplicate and cap at 10
  }

  /**
   * Rebuilds all indexes from scratch.
   * Called after bulk operations like purge or capacity eviction.
   *
   * @private
   */
  _rebuildAllIndexes() {
    // Clear all indexes
    this._titleIndex.clear();
    this._idIndex.clear();
    this._skillIndex.clear();
    this._categoryIndex.clear();
    this._tagIndex.clear();
    this._layerIndex.clear();
    this._keywordIndex.clear();

    // Rebuild from current experiences
    for (const exp of this.experiences) {
      this._titleIndex.add(exp.title);
      this._idIndex.set(exp.id, exp);
      this._updateMultiIndex(exp);
    }
  }

  /**
   * Evicts experiences based on value density to maintain capacity.
   * Considers: hitCount, recency, evolutionCount, knowledge layer.
   *
   * @param {number} targetCapacity - Target number of experiences to keep
   * @returns {number} Number of experiences evicted
   * @private
   */
  _evictByValueDensity(targetCapacity) {
    if (this.experiences.length <= targetCapacity) return 0;

    // Compute value score for each experience
    const scored = this.experiences.map(exp => {
      const value = this._computeExperienceValue(exp);
      const size = JSON.stringify(exp).length;
      return {
        exp,
        value,
        size,
        density: value / Math.max(size, 100), // Value per byte
      };
    });

    // Sort by density (ascending - lowest value density first)
    scored.sort((a, b) => a.density - b.density);

    // Determine how many to evict
    const toEvict = this.experiences.length - targetCapacity;
    const evictedIds = new Set(scored.slice(0, toEvict).map(s => s.exp.id));

    // Remove evicted experiences
    this.experiences = this.experiences.filter(e => !evictedIds.has(e.id));

    // Rebuild all indexes
    this._rebuildAllIndexes();

    return toEvict;
  }

  /**
   * Computes a composite value score for an experience.
   * Factors: hitCount, recency, evolutionCount, knowledge layer importance.
   *
   * @param {Experience} exp
   * @returns {number}
   * @private
   */
  _computeExperienceValue(exp) {
    const hitScore = (exp.hitCount || 0) * 1.0;

    // Recency: exponential decay with 60-day half-life
    const ageDays = (Date.now() - new Date(exp.updatedAt || exp.createdAt).getTime()) / 86400000;
    const recencyScore = Math.exp(-ageDays / 60);

    // Evolution: evolved experiences are more valuable
    const evolutionScore = (exp.evolutionCount || 0) * 2.0;

    // Layer weight: PRACTICE layer is most valuable
    const layer = getLayerForCategory(exp.category);
    const layerWeight = layer === KnowledgeLayer.PRACTICE ? 1.5 :
                        layer === KnowledgeLayer.DOMAIN ? 1.2 : 1.0;

    // Content quality indicators
    const hasCodeExample = exp.codeExample ? 1.0 : 0.0;
    const hasUpdates = exp.updates && exp.updates.length > 0 ? 0.5 : 0.0;
    const hasTags = exp.tags && exp.tags.length > 0 ? 0.3 : 0.0;

    return (hitScore + evolutionScore + hasCodeExample + hasUpdates + hasTags) * recencyScore * layerWeight;
  }

  /**
   * Public API: Remove experiences matching a filter predicate.
   * Use this instead of directly assigning to `this.experiences` from external modules.
   * Handles index rebuilding, persistence, and event emission.
   *
   * @param {Function} predicate - Function(exp) → true to REMOVE, false to KEEP
   * @returns {{ removed: number, remaining: number }}
   */
  removeByFilter(predicate) {
    if (typeof predicate !== 'function') {
      throw new Error('[ExperienceStore] removeByFilter() requires a function predicate');
    }
    const before = this.experiences.length;
    this.experiences = this.experiences.filter(e => !predicate(e));
    const removed = before - this.experiences.length;
    if (removed > 0) {
      this._rebuildAllIndexes();
      this._clearQueryCache();
      this._save();

      // Event-Driven: Publish bulk removal event
      const eventBus = getGlobalEventBus();
      eventBus.emit(ExperienceEvents.EXPERIENCE_DELETED || 'experience:deleted', {
        removedCount: removed,
        remaining: this.experiences.length,
        timestamp: new Date().toISOString(),
      });
    }
    return { removed, remaining: this.experiences.length };
  }

  /**
   * Public API: Get the count of experiences.
   * Use this instead of accessing `experiences.length` directly from external modules.
   *
   * @returns {number}
   */
  getCount() {
    return this.experiences.length;
  }

  /**
   * Public API: Persist all in-memory experiences to disk.
   * Delegates to the internal _save() method.
   * Use this instead of calling _save() directly from external modules.
   */
  save() {
    return this._save();
  }

  _save() {
    // P0-1 fix: Switched from async Promise-chain queue to synchronous write.
    // The original async queue caused data loss risk: callers (record(), purgeExpired(), etc.)
    // did not await the returned Promise, so process crashes could lose unflushed writes.
    // Since we already use atomic write (tmp + rename), synchronous writeFileSync is safe
    // and guarantees data is on disk when _save() returns.
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // N37 fix: atomic write (tmp + rename)
      const tmpPath = this.storePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(this.experiences, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.storePath);
      this._dirty = false;
    } catch (err) {
      console.warn(`[ExperienceStore] Could not save experiences: ${err.message}`);
    }
  }

  // ─── P4a: Query Cache Management ─────────────────────────────────────────

  /**
   * Gets cached search results if available and not expired.
   *
   * @param {string} cacheKey - Cache key for the query
   * @returns {Experience[]|null} Cached results or null
   * @private
   */
  _getCachedResults(cacheKey) {
    const cached = this._queryCache.get(cacheKey);
    if (!cached) return null;

    const now = Date.now();
    if (now - cached.timestamp > this._queryCacheTTL) {
      // Cache expired
      this._queryCache.delete(cacheKey);
      return null;
    }

    return cached.results;
  }

  /**
   * Caches search results for future queries.
   *
   * @param {string} cacheKey - Cache key for the query
   * @param {Experience[]} results - Results to cache
   * @private
   */
  _cacheResults(cacheKey, results) {
    // Enforce max cache size using LRU eviction
    if (this._queryCache.size >= this._queryCacheMaxSize) {
      // Remove oldest entry (first in map)
      const firstKey = this._queryCache.keys().next().value;
      this._queryCache.delete(firstKey);
    }

    this._queryCache.set(cacheKey, {
      results: results.slice(0, 50), // Cache up to 50 results
      timestamp: Date.now(),
    });
  }

  /**
   * Clears the query cache. Called when data changes.
   *
   * @private
   */
  _clearQueryCache() {
    this._queryCache.clear();
  }

  /**
   * Gets query cache statistics.
   *
   * @returns {{size: number, hitRate: number}}
   */
  getQueryCacheStats() {
    return {
      size: this._queryCache.size,
      maxSize: this._queryCacheMaxSize,
      ttl: this._queryCacheTTL,
    };
  }
}

// ─── Apply Mixins ─────────────────────────────────────────────────────────────
// Mixins add methods to ExperienceStore.prototype so all instances share them.
// This keeps each concern in its own file while maintaining a single class API.

Object.assign(ExperienceStore.prototype, ExperienceQueryMixin);
Object.assign(ExperienceStore.prototype, ExperienceEvolutionMixin);
Object.assign(ExperienceStore.prototype, ExperienceTransferMixin);
Object.assign(ExperienceStore.prototype, ExperienceDistillationMixin);
Object.assign(ExperienceStore.prototype, ExperienceAbstractionMixin);
Object.assign(ExperienceStore.prototype, ExperienceHealthMixin);

// ─── Backward-Compatible Exports ────────────────────────────────────────────
// All existing require('./experience-store') consumers continue to work unchanged.

module.exports = {
  ExperienceStore,
  ExperienceType,
  ExperienceCategory,
  UNIVERSAL_CATEGORIES,
  STOPWORDS,
  SHORT_WORD_WHITELIST,
  extractKeywords,
  // P1 enhancement: Content deduplication utilities
  ExperienceDeduplicator: require('./experience-query').ExperienceDeduplicator,
  computeExperienceSimilarity: require('./experience-query').computeExperienceSimilarity,
};