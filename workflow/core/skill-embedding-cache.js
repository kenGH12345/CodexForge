const fs = require('fs');
const path = require('path');

const { Logger } = require('./logger');

class SkillEmbeddingCache {
  #cacheDir;
  #logger;
  #onDemandCache = new Map();

  constructor(cacheDir = '.workflow/skill-embeddings/') {
    this.#cacheDir = cacheDir;
    this.#logger = new Logger('SkillEmbeddingCache');
    this._ensureCacheDir();
  }

  static create(cacheDir = '.workflow/skill-embeddings/') {
    return new SkillEmbeddingCache(cacheDir);
  }

  _ensureCacheDir() {
    if (!fs.existsSync(this.#cacheDir)) {
      fs.mkdirSync(this.#cacheDir, { recursive: true });
    }
  }

  _computeHash(content) {
    const start = content.slice(0, 100);
    const end = content.slice(-100);
    const len = String(content.length);
    return `${len}_${this._simpleHash(start + end)}`;
  }

  _simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  _getCacheFilePath(skillName) {
    const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.#cacheDir, `${safeName}.json`);
  }

  _readCacheFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
      return null;
    }
  }

  _writeCacheFile(filePath, data) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (err) {
      this.#logger.warn(`Failed to write cache: ${filePath}`);
      return false;
    }
  }

  getEmbedding(skillName, skillContent) {
    if (!skillContent) return null;

    const currentHash = this._computeHash(skillContent);
    const memCached = this.#onDemandCache.get(skillName);
    if (memCached && memCached.skillHash === currentHash) {
      return memCached.embedding;
    }

    const cacheFile = this._getCacheFilePath(skillName);
    const diskCached = this._readCacheFile(cacheFile);
    if (diskCached && diskCached.skillHash === currentHash) {
      this.#onDemandCache.set(skillName, diskCached);
      return diskCached.embedding;
    }

    return null;
  }

  setEmbedding(skillName, skillContent, embedding) {
    if (!skillContent || !embedding) return false;

    const entry = {
      skillName,
      skillHash: this._computeHash(skillContent),
      embedding,
      timestamp: new Date().toISOString(),
    };

    this.#onDemandCache.set(skillName, entry);
    return this._writeCacheFile(this._getCacheFilePath(skillName), entry);
  }

  preheat(skillContents, embedFn) {
    const entries = skillContents instanceof Map
      ? Array.from(skillContents.entries())
      : Object.entries(skillContents);

    this.#logger.info(`Preheating ${entries.length} skill embeddings...`);

    const results = { hit: 0, computed: 0, failed: 0 };

    for (const [skillName, content] of entries) {
      const cached = this.getEmbedding(skillName, content);
      if (cached) {
        results.hit++;
        continue;
      }

      if (embedFn) {
        try {
          const embedding = embedFn(content);
          this.setEmbedding(skillName, content, embedding);
          results.computed++;
        } catch (err) {
          this.#logger.warn(`Preheating failed for ${skillName}: ${err.message}`);
          results.failed++;
        }
      } else {
        results.failed++;
      }
    }

    this.#logger.info(`Preheat done: ${results.hit} cached, ${results.computed} computed, ${results.failed} failed`);
    return results;
  }

  clear() {
    this.#onDemandCache.clear();
  }

  getStats() {
    return {
      inMemoryEntries: this.#onDemandCache.size,
      cacheDir: this.#cacheDir,
    };
  }
}

module.exports = { SkillEmbeddingCache };
