/**
 * Workflow Introspection Collector
 *
 * Unified log collection system for the 7 core workflow modules:
 *   - Skill (skill-evolution.js)
 *   - Prompt (prompt-builder.js)
 *   - Experience (experience-store.js)
 *   - Framework (code-graph.js)
 *   - Architecture (architecture-review-agent.js)
 *   - Scan/Audit (deep-audit-orchestrator.js)
 *
 * Design:
 *   - Zero-overhead in-memory collection during workflow execution
 *   - Structured log entries with module, action, context, and metadata
 *   - Automatic correlation tracking for cross-module data flow analysis
 *   - Integration with existing logger.js for file persistence
 *
 * Usage:
 *   const { introspectionCollector } = require('./workflow-introspection-collector');
 *   introspectionCollector.record('Skill', 'skill_registered', { name: 'go_crud' });
 *   introspectionCollector.record('Prompt', 'skill_injected', { skillName: 'go_crud' }, { traceId });
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Module Types ──────────────────────────────────────────────────────────────

const ModuleType = {
  SKILL:        'Skill',
  PROMPT:       'Prompt',
  EXPERIENCE:   'Experience',
  FRAMEWORK:    'Framework',
  ARCHITECTURE: 'Architecture',
  SCAN:         'Scan',
  UNKNOWN:      'Unknown',
};

// ─── Action Categories ─────────────────────────────────────────────────────────

const ActionCategory = {
  // Lifecycle events
  REGISTERED:   'registered',
  EVOLVED:      'evolved',
  RETIRED:      'retired',
  
  // Usage events
  INJECTED:     'injected',
  USED:         'used',
  QUERIED:      'queried',
  MATCHED:      'matched',
  
  // Analysis events
  ANALYZED:     'analyzed',
  SCANNED:      'scanned',
  REVIEWED:     'reviewed',
  CHECKED:      'checked',
  
  // Data flow events
  PRODUCED:     'produced',
  CONSUMED:     'consumed',
  TRANSFORMED:  'transformed',
  
  // Result events
  PASSED:       'passed',
  FAILED:       'failed',
  FIXED:        'fixed',
  IGNORED:      'ignored',
};

// ─── Log Entry Structure ───────────────────────────────────────────────────────

/**
 * @typedef {object} IntrospectionEntry
 * @property {string} id - Unique entry ID
 * @property {string} module - Module type (ModuleType)
 * @property {string} action - Action performed (ActionCategory)
 * @property {string} timestamp - ISO timestamp
 * @property {string} sessionId - Workflow session ID
 * @property {string} [stage] - Current workflow stage
 * @property {object} context - Action-specific context data
 * @property {object} [correlation] - Cross-module correlation info
 * @property {string} [correlation.traceId] - Trace ID for distributed tracking
 * @property {string} [correlation.parentId] - Parent entry ID
 * @property {string[]} [correlation.relatedIds] - Related entry IDs
 */

// ─── Workflow Introspection Collector ──────────────────────────────────────────

class WorkflowIntrospectionCollector {
  constructor() {
    /** @type {IntrospectionEntry[]} */
    this._entries = [];
    this._sessionId = null;
    this._currentStage = null;
    this._outputDir = null;
    this._enabled = true;
    
    // Correlation tracking for cross-module analysis
    /** @type {Map<string, string[]>} traceId -> entryIds */
    this._traceIndex = new Map();
    /** @type {Map<string, Set<string>>} module -> entityIds */
    this._moduleEntityIndex = new Map();
  }

  /**
   * Initialize the collector with session context.
   *
   * @param {object} context
   * @param {string} context.sessionId - Unique session identifier
   * @param {string} context.outputDir - Output directory for reports
   * @param {boolean} [context.enabled=true] - Whether collection is enabled
   */
  initialize({ sessionId, outputDir, enabled = true }) {
    this._sessionId = sessionId;
    this._outputDir = outputDir;
    this._enabled = enabled;
    this._entries = [];
    this._traceIndex.clear();
    this._moduleEntityIndex.clear();
  }

  /**
   * Set the current workflow stage.
   * @param {string} stage
   */
  setStage(stage) {
    this._currentStage = stage;
  }

  /**
   * Record an introspection log entry.
   *
   * @param {string} module - Module type (ModuleType)
   * @param {string} action - Action performed (ActionCategory)
   * @param {object} context - Action-specific context data
   * @param {object} [correlation] - Optional correlation info
   * @param {string} [correlation.traceId] - Trace ID
   * @param {string} [correlation.parentId] - Parent entry ID
   * @returns {string} Entry ID
   */
  record(module, action, context = {}, correlation = null) {
    if (!this._enabled) return null;

    const entry = {
      id: this._generateId(),
      module,
      action,
      timestamp: new Date().toISOString(),
      sessionId: this._sessionId,
      stage: this._currentStage,
      context: { ...context },
    };

    if (correlation) {
      entry.correlation = { ...correlation };
      this._indexCorrelation(entry);
    }

    this._entries.push(entry);
    this._indexModuleEntity(module, context);

    return entry.id;
  }

  /**
   * Record a Skill module event.
   */
  recordSkill(action, context, correlation) {
    return this.record(ModuleType.SKILL, action, context, correlation);
  }

  /**
   * Record a Prompt module event.
   */
  recordPrompt(action, context, correlation) {
    return this.record(ModuleType.PROMPT, action, context, correlation);
  }

  /**
   * Record an Experience module event.
   */
  recordExperience(action, context, correlation) {
    return this.record(ModuleType.EXPERIENCE, action, context, correlation);
  }

  /**
   * Record a Framework module event.
   */
  recordFramework(action, context, correlation) {
    return this.record(ModuleType.FRAMEWORK, action, context, correlation);
  }

  /**
   * Record an Architecture module event.
   */
  recordArchitecture(action, context, correlation) {
    return this.record(ModuleType.ARCHITECTURE, action, context, correlation);
  }

  /**
   * Record a Scan/Audit module event.
   */
  recordScan(action, context, correlation) {
    return this.record(ModuleType.SCAN, action, context, correlation);
  }

  // ─── Query Methods ────────────────────────────────────────────────────────────

  /**
   * Get all entries.
   * @returns {IntrospectionEntry[]}
   */
  getAll() {
    return [...this._entries];
  }

  /**
   * Get entries by module.
   * @param {string} module
   * @returns {IntrospectionEntry[]}
   */
  getByModule(module) {
    return this._entries.filter(e => e.module === module);
  }

  /**
   * Get entries by action.
   * @param {string} action
   * @returns {IntrospectionEntry[]}
   */
  getByAction(action) {
    return this._entries.filter(e => e.action === action);
  }

  /**
   * Get entries by trace ID.
   * @param {string} traceId
   * @returns {IntrospectionEntry[]}
   */
  getByTraceId(traceId) {
    const entryIds = this._traceIndex.get(traceId) || [];
    return this._entries.filter(e => entryIds.includes(e.id));
  }

  /**
   * Get entries within a time range.
   * @param {string} start - ISO timestamp
   * @param {string} end - ISO timestamp
   * @returns {IntrospectionEntry[]}
   */
  getByTimeRange(start, end) {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    return this._entries.filter(e => {
      const ts = new Date(e.timestamp).getTime();
      return ts >= startMs && ts <= endMs;
    });
  }

  /**
   * Find entries related to a specific entity.
   * @param {string} module
   * @param {string} entityKey - The entity identifier key (e.g., 'skillName', 'experienceId')
   * @param {string} entityValue - The entity identifier value
   * @returns {IntrospectionEntry[]}
   */
  getByEntity(module, entityKey, entityValue) {
    return this._entries.filter(e => {
      if (e.module !== module) return false;
      return e.context[entityKey] === entityValue;
    });
  }

  // ─── Cross-Module Analysis ───────────────────────────────────────────────────

  /**
   * Find data flow between two modules.
   * Returns entries where a trace ID spans both modules.
   *
   * @param {string} fromModule
   * @param {string} toModule
   * @returns {{ traceId: string, fromEntries: IntrospectionEntry[], toEntries: IntrospectionEntry[] }[]}
   */
  findDataFlow(fromModule, toModule) {
    const flows = [];
    
    for (const [traceId, entryIds] of this._traceIndex) {
      const entries = this._entries.filter(e => entryIds.includes(e.id));
      const fromEntries = entries.filter(e => e.module === fromModule);
      const toEntries = entries.filter(e => e.module === toModule);
      
      if (fromEntries.length > 0 && toEntries.length > 0) {
        flows.push({ traceId, fromEntries, toEntries });
      }
    }
    
    return flows;
  }

  /**
   * Find orphaned entities (entities that were produced but never consumed).
   *
   * @param {string} producerModule
   * @param {string} consumerModule
   * @param {string} entityKey
   * @returns {string[]} Orphaned entity values
   */
  findOrphanedEntities(producerModule, consumerModule, entityKey) {
    const produced = new Set();
    const consumed = new Set();
    
    for (const e of this._entries) {
      const entityValue = e.context[entityKey];
      if (!entityValue) continue;
      
      if (e.module === producerModule && e.action === ActionCategory.PRODUCED) {
        produced.add(entityValue);
      }
      if (e.module === consumerModule && e.action === ActionCategory.CONSUMED) {
        consumed.add(entityValue);
      }
    }
    
    return Array.from(produced).filter(p => !consumed.has(p));
  }

  /**
   * Get the complete lifecycle of an entity across modules.
   *
   * @param {string} entityKey
   * @param {string} entityValue
   * @returns {IntrospectionEntry[]}
   */
  getEntityLifecycle(entityKey, entityValue) {
    return this._entries
      .filter(e => e.context[entityKey] === entityValue)
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  // ─── Statistics ───────────────────────────────────────────────────────────────

  /**
   * Get collection statistics.
   */
  getStats() {
    const byModule = {};
    const byAction = {};
    
    for (const e of this._entries) {
      byModule[e.module] = (byModule[e.module] || 0) + 1;
      byAction[e.action] = (byAction[e.action] || 0) + 1;
    }
    
    return {
      totalEntries: this._entries.length,
      uniqueTraces: this._traceIndex.size,
      byModule,
      byAction,
      moduleCoverage: Object.keys(ModuleType).filter(m => byModule[ModuleType[m]] > 0).length,
    };
  }

  // ─── Persistence ──────────────────────────────────────────────────────────────

  /**
   * Persist the collected entries to JSONL file.
   * @returns {string|null} Path to written file
   */
  persist() {
    if (!this._outputDir || this._entries.length === 0) return null;
    
    try {
      if (!fs.existsSync(this._outputDir)) {
        fs.mkdirSync(this._outputDir, { recursive: true });
      }
      
      const filePath = path.join(this._outputDir, 'workflow-introspection.jsonl');
      const lines = this._entries.map(e => JSON.stringify(e));
      fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
      
      return filePath;
    } catch (err) {
      console.warn(`[IntrospectionCollector] Failed to persist: ${err.message}`);
      return null;
    }
  }

  /**
   * Load entries from a JSONL file.
   * @param {string} filePath
   */
  load(filePath) {
    if (!fs.existsSync(filePath)) return;
    
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      
      for (const line of lines) {
        if (line.trim()) {
          const entry = JSON.parse(line);
          this._entries.push(entry);
          if (entry.correlation?.traceId) {
            this._indexCorrelation(entry);
          }
        }
      }
    } catch (err) {
      console.warn(`[IntrospectionCollector] Failed to load: ${err.message}`);
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  _generateId() {
    return `WI-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  }

  _indexCorrelation(entry) {
    if (!entry.correlation?.traceId) return;
    
    const traceId = entry.correlation.traceId;
    if (!this._traceIndex.has(traceId)) {
      this._traceIndex.set(traceId, []);
    }
    this._traceIndex.get(traceId).push(entry.id);
  }

  _indexModuleEntity(module, context) {
    if (!this._moduleEntityIndex.has(module)) {
      this._moduleEntityIndex.set(module, new Set());
    }
    
    // Extract entity identifiers from context
    const entityKeys = ['skillName', 'experienceId', 'promptId', 'findingId', 'ruleId'];
    for (const key of entityKeys) {
      if (context[key]) {
        this._moduleEntityIndex.get(module).add(`${key}:${context[key]}`);
      }
    }
  }

  /**
   * Clear all entries.
   */
  clear() {
    this._entries = [];
    this._traceIndex.clear();
    this._moduleEntityIndex.clear();
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

const introspectionCollector = new WorkflowIntrospectionCollector();

module.exports = {
  WorkflowIntrospectionCollector,
  introspectionCollector,
  ModuleType,
  ActionCategory,
};