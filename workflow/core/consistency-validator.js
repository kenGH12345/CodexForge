/**
 * Consistency Validator
 *
 * Cross-module consistency checker for the 7 core workflow modules.
 * Validates data flow, entity references, and logical consistency
 * between Skill, Prompt, Experience, Framework, Architecture, and Scan modules.
 *
 * Validation Rules:
 *   1. Skill ↔ Prompt: Injected skills exist and versions match
 *   2. Experience ↔ Skill: Evolutions are traceable to source experiences
 *   3. Architecture ↔ Scan: Findings align between review and audit
 *   4. Framework ↔ Experience: CodeGraph coverage matches experience sources
 *   5. Cross-Module Data Flow: All produced data is consumed appropriately
 *
 * Usage:
 *   const validator = new ConsistencyValidator(introspectionCollector);
 *   const report = validator.validateAll();
 */

'use strict';

const { ModuleType, ActionCategory } = require('./workflow-introspection-collector');

// ─── Validation Severity ───────────────────────────────────────────────────────

const ValidationSeverity = {
  ERROR:   'error',   // Inconsistency that may cause workflow failures
  WARNING: 'warning', // Potential issue that should be reviewed
  INFO:    'info',    // FYI, no action required
};

// ─── Validation Result Structure ───────────────────────────────────────────────

/**
 * @typedef {object} ValidationIssue
 * @property {string} id - Unique issue ID
 * @property {string} category - Issue category
 * @property {string} severity - ValidationSeverity
 * @property {string} description - Human-readable description
 * @property {object} details - Detailed context
 * @property {string[]} affectedModules - Module names involved
 * @property {string[]} relatedEntryIds - Related introspection entry IDs
 * @property {string} [suggestion] - Suggested fix
 */

// ─── Consistency Validator ─────────────────────────────────────────────────────

class ConsistencyValidator {
  /**
   * @param {WorkflowIntrospectionCollector} collector
   */
  constructor(collector) {
    this._collector = collector;
    this._issues = [];
  }

  /**
   * Run all validations and return a comprehensive report.
   *
   * @returns {object} Validation report
   */
  validateAll() {
    this._issues = [];
    
    // Run all validation rules
    this._validateSkillPromptConsistency();
    this._validateExperienceSkillConsistency();
    this._validateArchitectureScanConsistency();
    this._validateFrameworkExperienceConsistency();
    this._validateCrossModuleDataFlow();
    this._validateVersionConsistency();
    
    return this._generateReport();
  }

  /**
   * Validate a specific category only.
   * @param {string} category
   */
  validateCategory(category) {
    this._issues = [];
    
    switch (category) {
      case 'skill-prompt':
        this._validateSkillPromptConsistency();
        break;
      case 'experience-skill':
        this._validateExperienceSkillConsistency();
        break;
      case 'architecture-scan':
        this._validateArchitectureScanConsistency();
        break;
      case 'framework-experience':
        this._validateFrameworkExperienceConsistency();
        break;
      case 'data-flow':
        this._validateCrossModuleDataFlow();
        break;
      case 'version':
        this._validateVersionConsistency();
        break;
      default:
        throw new Error(`Unknown validation category: ${category}`);
    }
    
    return this._generateReport();
  }

  // ─── Validation Rule 1: Skill ↔ Prompt ─────────────────────────────────────────

  /**
   * Validate consistency between Skill and Prompt modules.
   * - All injected skills must be registered
   * - Versions should match
   */
  _validateSkillPromptConsistency() {
    const skillEntries = this._collector.getByModule(ModuleType.SKILL);
    const promptEntries = this._collector.getByModule(ModuleType.PROMPT);
    
    // Build skill registry state
    const registeredSkills = new Map(); // name -> { version, registeredAt }
    const evolvedSkills = new Map(); // name -> [{ version, evolvedAt }]
    
    for (const entry of skillEntries) {
      const name = entry.context.skillName;
      if (!name) continue;
      
      if (entry.action === ActionCategory.REGISTERED) {
        registeredSkills.set(name, {
          version: entry.context.version,
          registeredAt: entry.timestamp,
        });
      }
      if (entry.action === ActionCategory.EVOLVED) {
        if (!evolvedSkills.has(name)) {
          evolvedSkills.set(name, []);
        }
        evolvedSkills.get(name).push({
          version: entry.context.newVersion,
          evolvedAt: entry.timestamp,
        });
      }
    }
    
    // Check prompt injections
    for (const entry of promptEntries) {
      if (entry.action !== ActionCategory.INJECTED) continue;
      
      const skillName = entry.context.skillName;
      const injectedVersion = entry.context.version;
      
      if (!skillName) continue;
      
      // Check if skill is registered
      if (!registeredSkills.has(skillName)) {
        this._addIssue({
          category: 'Skill-Prompt Consistency',
          severity: ValidationSeverity.ERROR,
          description: `Prompt injected unregistered skill: '${skillName}'`,
          details: {
            skillName,
            promptEntry: entry.id,
          },
          affectedModules: [ModuleType.SKILL, ModuleType.PROMPT],
          relatedEntryIds: [entry.id],
          suggestion: `Register skill '${skillName}' before injecting it into prompts`,
        });
        continue;
      }
      
      // Check version consistency
      if (injectedVersion) {
        const registered = registeredSkills.get(skillName);
        const evolutions = evolvedSkills.get(skillName) || [];
        const allVersions = [registered, ...evolutions].map(v => v.version);
        
        if (!allVersions.includes(injectedVersion)) {
          this._addIssue({
            category: 'Skill-Prompt Consistency',
            severity: ValidationSeverity.WARNING,
            description: `Prompt injected skill '${skillName}' with unexpected version ${injectedVersion}`,
            details: {
              skillName,
              injectedVersion,
              knownVersions: allVersions,
              promptEntry: entry.id,
            },
            affectedModules: [ModuleType.SKILL, ModuleType.PROMPT],
            relatedEntryIds: [entry.id],
            suggestion: `Verify version ${injectedVersion} is valid or update to latest: ${allVersions[allVersions.length - 1]}`,
          });
        }
      }
    }
    
    // Check for unused skills
    const injectedSkills = new Set(
      promptEntries
        .filter(e => e.action === ActionCategory.INJECTED)
        .map(e => e.context.skillName)
        .filter(Boolean)
    );
    
    for (const [skillName] of registeredSkills) {
      if (!injectedSkills.has(skillName)) {
        this._addIssue({
          category: 'Skill-Prompt Consistency',
          severity: ValidationSeverity.INFO,
          description: `Skill '${skillName}' is registered but never injected into prompts`,
          details: { skillName },
          affectedModules: [ModuleType.SKILL, ModuleType.PROMPT],
          relatedEntryIds: [],
          suggestion: `Consider adding '${skillName}' to relevant prompt contexts or retire if obsolete`,
        });
      }
    }
  }

  // ─── Validation Rule 2: Experience ↔ Skill ─────────────────────────────────────

  /**
   * Validate consistency between Experience and Skill modules.
   * - Skill evolutions should trace back to source experiences
   * - Experience categories should align with skill domains
   */
  _validateExperienceSkillConsistency() {
    const experienceEntries = this._collector.getByModule(ModuleType.EXPERIENCE);
    const skillEntries = this._collector.getByModule(ModuleType.SKILL);
    
    // Build experience records
    const recordedExperiences = new Map(); // id -> entry
    const skillEvolutions = new Map(); // skillName -> [{ entry, sourceExpId }]
    
    for (const entry of experienceEntries) {
      if (entry.action === ActionCategory.REGISTERED) {
        recordedExperiences.set(entry.context.experienceId, entry);
      }
    }
    
    for (const entry of skillEntries) {
      if (entry.action === ActionCategory.EVOLVED) {
        const skillName = entry.context.skillName;
        if (!skillEvolutions.has(skillName)) {
          skillEvolutions.set(skillName, []);
        }
        skillEvolutions.get(skillName).push({
          entry,
          sourceExpId: entry.context.sourceExpId,
        });
      }
    }
    
    // Check evolution traceability
    for (const [skillName, evolutions] of skillEvolutions) {
      for (const { entry, sourceExpId } of evolutions) {
        if (sourceExpId && !recordedExperiences.has(sourceExpId)) {
          this._addIssue({
            category: 'Experience-Skill Consistency',
            severity: ValidationSeverity.WARNING,
            description: `Skill '${skillName}' evolution references unknown experience: '${sourceExpId}'`,
            details: {
              skillName,
              sourceExpId,
              evolutionEntry: entry.id,
            },
            affectedModules: [ModuleType.EXPERIENCE, ModuleType.SKILL],
            relatedEntryIds: [entry.id],
            suggestion: `Verify experience ID is correct or record the missing experience`,
          });
        }
      }
    }
    
    // Check for un-evolved high-impact experiences
    const evolvedExpIds = new Set();
    for (const [, evolutions] of skillEvolutions) {
      for (const { sourceExpId } of evolutions) {
        if (sourceExpId) evolvedExpIds.add(sourceExpId);
      }
    }
    
    for (const [expId, entry] of recordedExperiences) {
      const isHighImpact = entry.context.impact === 'high' || entry.context.type === 'negative';
      if (isHighImpact && !evolvedExpIds.has(expId)) {
        this._addIssue({
          category: 'Experience-Skill Consistency',
          severity: ValidationSeverity.INFO,
          description: `High-impact experience '${expId}' has not triggered any skill evolution`,
          details: {
            experienceId: expId,
            type: entry.context.type,
            category: entry.context.category,
          },
          affectedModules: [ModuleType.EXPERIENCE, ModuleType.SKILL],
          relatedEntryIds: [entry.id],
          suggestion: `Consider evolving relevant skill based on this experience`,
        });
      }
    }
  }

  // ─── Validation Rule 3: Architecture ↔ Scan ────────────────────────────────────

  /**
   * Validate consistency between Architecture and Scan modules.
   * - Architecture review findings should be reflected in scan results
   * - Critical architecture issues should trigger scan failures
   */
  _validateArchitectureScanConsistency() {
    const archEntries = this._collector.getByModule(ModuleType.ARCHITECTURE);
    const scanEntries = this._collector.getByModule(ModuleType.SCAN);
    
    // Build architecture findings
    const archFindings = new Map(); // findingId -> entry
    const archFailures = [];
    
    for (const entry of archEntries) {
      if (entry.action === ActionCategory.FAILED) {
        archFailures.push(entry);
      }
      if (entry.context.findingId) {
        archFindings.set(entry.context.findingId, entry);
      }
    }
    
    // Build scan findings
    const scanFindings = new Map(); // findingId -> entry
    const scanFixed = new Set();
    
    for (const entry of scanEntries) {
      if (entry.context.findingId) {
        scanFindings.set(entry.context.findingId, entry);
      }
      if (entry.action === ActionCategory.FIXED && entry.context.findingId) {
        scanFixed.add(entry.context.findingId);
      }
    }
    
    // Check if architecture failures are reflected in scan
    for (const archFailure of archFailures) {
      const findingId = archFailure.context.findingId;
      const severity = archFailure.context.severity;
      
      if (findingId && !scanFindings.has(findingId)) {
        // High/critical severity should be in scan
        if (severity === 'critical' || severity === 'high') {
          this._addIssue({
            category: 'Architecture-Scan Consistency',
            severity: ValidationSeverity.WARNING,
            description: `Critical architecture finding '${findingId}' not found in scan results`,
            details: {
              findingId,
              severity,
              architectureEntry: archFailure.id,
            },
            affectedModules: [ModuleType.ARCHITECTURE, ModuleType.SCAN],
            relatedEntryIds: [archFailure.id],
            suggestion: `Ensure critical architecture findings are included in deep audit`,
          });
        }
      }
    }
    
    // Check if scans fixed issues not found by architecture review
    for (const findingId of scanFixed) {
      if (!archFindings.has(findingId)) {
        this._addIssue({
          category: 'Architecture-Scan Consistency',
          severity: ValidationSeverity.INFO,
          description: `Scan fixed finding '${findingId}' that was not found by architecture review`,
          details: { findingId },
          affectedModules: [ModuleType.ARCHITECTURE, ModuleType.SCAN],
          relatedEntryIds: [scanFindings.get(findingId)?.id].filter(Boolean),
          suggestion: `Review if architecture review should have caught this issue`,
        });
      }
    }
  }

  // ─── Validation Rule 4: Framework ↔ Experience ─────────────────────────────────

  /**
   * Validate consistency between Framework and Experience modules.
   * - CodeGraph coverage should include files referenced in experiences
   * - Hotspot analysis should align with negative experiences
   */
  _validateFrameworkExperienceConsistency() {
    const frameworkEntries = this._collector.getByModule(ModuleType.FRAMEWORK);
    const experienceEntries = this._collector.getByModule(ModuleType.EXPERIENCE);
    
    // Build CodeGraph indexed files
    const indexedFiles = new Set();
    const hotspots = new Map(); // file -> score
    
    for (const entry of frameworkEntries) {
      if (entry.action === ActionCategory.ANALYZED && entry.context.indexedFiles) {
        for (const file of entry.context.indexedFiles) {
          indexedFiles.add(file);
        }
      }
      if (entry.context.hotspots) {
        for (const [file, score] of Object.entries(entry.context.hotspots)) {
          hotspots.set(file, score);
        }
      }
    }
    
    // Check experience source files
    for (const entry of experienceEntries) {
      if (entry.action !== ActionCategory.REGISTERED) continue;
      
      const sourceFile = entry.context.sourceFile;
      const isNegative = entry.context.type === 'negative';
      
      if (sourceFile && !indexedFiles.has(sourceFile)) {
        const severity = isNegative ? ValidationSeverity.WARNING : ValidationSeverity.INFO;
        this._addIssue({
          category: 'Framework-Experience Consistency',
          severity,
          description: `Experience references unindexed file: '${sourceFile}'`,
          details: {
            sourceFile,
            experienceId: entry.context.experienceId,
            type: entry.context.type,
          },
          affectedModules: [ModuleType.FRAMEWORK, ModuleType.EXPERIENCE],
          relatedEntryIds: [entry.id],
          suggestion: isNegative
            ? `Ensure CodeGraph includes '${sourceFile}' for accurate hotspot analysis`
            : `Consider adding '${sourceFile}' to CodeGraph for complete coverage`,
        });
      }
      
      // Check if negative experience aligns with hotspots
      if (isNegative && sourceFile && indexedFiles.has(sourceFile)) {
        const hotspotScore = hotspots.get(sourceFile);
        if (!hotspotScore || hotspotScore < 0.5) {
          this._addIssue({
            category: 'Framework-Experience Consistency',
            severity: ValidationSeverity.INFO,
            description: `Negative experience from '${sourceFile}' but low hotspot score (${hotspotScore || 0})`,
            details: {
              sourceFile,
              hotspotScore: hotspotScore || 0,
              experienceId: entry.context.experienceId,
            },
            affectedModules: [ModuleType.FRAMEWORK, ModuleType.EXPERIENCE],
            relatedEntryIds: [entry.id],
            suggestion: `Review hotspot scoring algorithm or consider this a data point for recalibration`,
          });
        }
      }
    }
  }

  // ─── Validation Rule 5: Cross-Module Data Flow ─────────────────────────────────

  /**
   * Validate overall cross-module data flow consistency.
   * - All produced entities should be consumed
   * - No circular dependencies
   */
  _validateCrossModuleDataFlow() {
    const produced = new Map(); // entityKey -> Set of { module, timestamp }
    const consumed = new Map(); // entityKey -> Set of { module, timestamp }
    
    // Track productions and consumptions
    for (const entry of this._collector.getAll()) {
      const entityId = entry.context.entityId || entry.context.skillName || 
                       entry.context.experienceId || entry.context.findingId;
      if (!entityId) continue;
      
      const key = `${entry.module}:${entityId}`;
      
      if (entry.action === ActionCategory.PRODUCED || 
          entry.action === ActionCategory.REGISTERED ||
          entry.action === ActionCategory.EVOLVED) {
        if (!produced.has(key)) produced.set(key, new Set());
        produced.get(key).add({ module: entry.module, timestamp: entry.timestamp });
      }
      
      if (entry.action === ActionCategory.CONSUMED || 
          entry.action === ActionCategory.USED ||
          entry.action === ActionCategory.INJECTED) {
        if (!consumed.has(key)) consumed.set(key, new Set());
        consumed.get(key).add({ module: entry.module, timestamp: entry.timestamp });
      }
    }
    
    // Check for un-consumed productions
    for (const [key, productions] of produced) {
      const consumptions = consumed.get(key);
      if (!consumptions || consumptions.size === 0) {
        const [module, entityId] = key.split(':');
        this._addIssue({
          category: 'Cross-Module Data Flow',
          severity: ValidationSeverity.INFO,
          description: `Entity '${entityId}' produced by ${module} was never consumed`,
          details: {
            entityId,
            producedBy: module,
            productionCount: productions.size,
          },
          affectedModules: [module],
          relatedEntryIds: [],
          suggestion: `Verify if this entity is needed or if consumers are not logging properly`,
        });
      }
    }
    
    // Check for consumed-but-not-produced (possible external entities)
    for (const [key, consumptions] of consumed) {
      if (!produced.has(key)) {
        const [module, entityId] = key.split(':');
        this._addIssue({
          category: 'Cross-Module Data Flow',
          severity: ValidationSeverity.INFO,
          description: `Entity '${entityId}' consumed by ${module} was not produced in this session`,
          details: {
            entityId,
            consumedBy: module,
            consumptionCount: consumptions.size,
          },
          affectedModules: [module],
          relatedEntryIds: [],
          suggestion: `Entity may be from external source or previous session - verify if expected`,
        });
      }
    }
  }

  // ─── Validation Rule 6: Version Consistency ────────────────────────────────────

  /**
   * Validate version consistency across modules.
   * - Skills shouldn't evolve backwards
   * - Experience timestamps should align with skill evolution
   */
  _validateVersionConsistency() {
    const skillEntries = this._collector.getByModule(ModuleType.SKILL);
    
    // Build version timeline per skill
    const skillTimelines = new Map(); // skillName -> [{ version, timestamp, action }]
    
    for (const entry of skillEntries) {
      const skillName = entry.context.skillName;
      if (!skillName) continue;
      
      if (!skillTimelines.has(skillName)) {
        skillTimelines.set(skillName, []);
      }
      
      const version = entry.context.version || entry.context.newVersion || entry.context.oldVersion;
      if (version) {
        skillTimelines.get(skillName).push({
          version,
          timestamp: entry.timestamp,
          action: entry.action,
          entryId: entry.id,
        });
      }
    }
    
    // Check version progression
    for (const [skillName, timeline] of skillTimelines) {
      // Sort by timestamp
      timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      
      // Parse versions (assuming semver-like format)
      for (let i = 1; i < timeline.length; i++) {
        const prev = this._parseVersion(timeline[i - 1].version);
        const curr = this._parseVersion(timeline[i].version);
        
        if (prev && curr) {
          const comparison = this._compareVersions(curr, prev);
          if (comparison < 0) {
            // Current version is lower than previous - possible rollback
            this._addIssue({
              category: 'Version Consistency',
              severity: ValidationSeverity.WARNING,
              description: `Skill '${skillName}' version decreased: ${timeline[i - 1].version} -> ${timeline[i].version}`,
              details: {
                skillName,
                fromVersion: timeline[i - 1].version,
                toVersion: timeline[i].version,
                fromTime: timeline[i - 1].timestamp,
                toTime: timeline[i].timestamp,
              },
              affectedModules: [ModuleType.SKILL],
              relatedEntryIds: [timeline[i - 1].entryId, timeline[i].entryId],
              suggestion: `Verify if this is an intentional rollback or a versioning error`,
            });
          }
        }
      }
    }
  }

  // ─── Report Generation ────────────────────────────────────────────────────────

  _generateReport() {
    const stats = this._calculateStats();
    
    return {
      timestamp: new Date().toISOString(),
      summary: {
        totalIssues: this._issues.length,
        errors: stats.errors,
        warnings: stats.warnings,
        infos: stats.infos,
        passRate: this._calculatePassRate(),
      },
      byCategory: this._groupByCategory(),
      byModule: this._groupByModule(),
      issues: this._issues,
      stats: this._collector.getStats(),
    };
  }

  _calculateStats() {
    return {
      errors: this._issues.filter(i => i.severity === ValidationSeverity.ERROR).length,
      warnings: this._issues.filter(i => i.severity === ValidationSeverity.WARNING).length,
      infos: this._issues.filter(i => i.severity === ValidationSeverity.INFO).length,
    };
  }

  _calculatePassRate() {
    if (this._issues.length === 0) return 100;
    const errors = this._issues.filter(i => i.severity === ValidationSeverity.ERROR).length;
    return Math.round(((this._issues.length - errors) / this._issues.length) * 100);
  }

  _groupByCategory() {
    const groups = {};
    for (const issue of this._issues) {
      if (!groups[issue.category]) {
        groups[issue.category] = [];
      }
      groups[issue.category].push(issue);
    }
    return groups;
  }

  _groupByModule() {
    const groups = {};
    for (const issue of this._issues) {
      for (const module of issue.affectedModules) {
        if (!groups[module]) groups[module] = [];
        groups[module].push(issue);
      }
    }
    return groups;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  _addIssue({ category, severity, description, details, affectedModules, relatedEntryIds, suggestion }) {
    this._issues.push({
      id: `VAL-${Date.now()}-${this._issues.length.toString().padStart(3, '0')}`,
      category,
      severity,
      description,
      details,
      affectedModules,
      relatedEntryIds: relatedEntryIds || [],
      suggestion,
    });
  }

  _parseVersion(versionStr) {
    if (!versionStr) return null;
    const parts = versionStr.split('.').map(Number);
    if (parts.some(isNaN)) return null;
    return parts;
  }

  _compareVersions(v1, v2) {
    // Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
    const len = Math.max(v1.length, v2.length);
    for (let i = 0; i < len; i++) {
      const n1 = v1[i] || 0;
      const n2 = v2[i] || 0;
      if (n1 > n2) return 1;
      if (n1 < n2) return -1;
    }
    return 0;
  }
}

module.exports = {
  ConsistencyValidator,
  ValidationSeverity,
};