/**
 * Skill Evolution Engine – Skill auto-evolution driven by experience feedback
 *
 * Inspired by AgentFlow's skill evolution mechanism:
 *  - Skills are standard operating procedures (SOP) for specific domains
 *  - High-frequency positive experiences trigger skill evolution
 *  - Complaint wall corrections feed back into skill updates
 *  - Each skill tracks its evolution history and version
 *  - Skills include: rules, SOP steps, checklists, anti-patterns, best practices
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, getDefaultOutputDir } = require('./constants');
const { introspectionCollector } = require('./workflow-introspection-collector');

// ─── Skill Evolution Engine ───────────────────────────────────────────────────

class SkillEvolutionEngine {
  /**
   * @param {string} [skillsDir] - Directory containing skill markdown files
   * @param {string} [registryPath] - Path to skill registry JSON
   */
  constructor(skillsDir = null, registryPath = null) {
    this.skillsDir = skillsDir || PATHS.SKILLS_DIR;
    this.registryPath = registryPath || path.join(getDefaultOutputDir(), 'skill-registry.json');
    /** @type {Map<string, SkillMeta>} */
    this.registry = new Map();
    /** @type {Map<string, string>} P1-5 fix: in-memory skill content cache for batch operations */
    this._skillContentCache = new Map();
    /**
     * LLM-Lite Skill Refiner (ADR-OpenSpace LLM-Lite).
     * Optional: injected via setLlmRefiner() when an LLM call function is available.
     * When set, enables:
     *   - Post-evolve refinement (consolidate bloated skills)
     *   - Pre-retire fix attempt (repair underperforming skills)
     *   - Auto-create content generation (high-quality initial content)
     * @type {import('./skill-llm-refiner').SkillLlmRefiner|null}
     */
    this._llmRefiner = null;
    /**
     * Version DAG (ADR-OpenSpace): Tracks the full lineage of every skill evolution.
     * Inspired by OpenSpace's SkillLineage — each evolution creates a node in a
     * directed acyclic graph (DAG) that records parent→child version relationships.
     *
     * Structure: Map<skillName, LineageNode[]>
     * Each LineageNode: { version, parentVersion, type, timestamp, summary, sourceExpId }
     *
     * Types:
     *   - 'create'   — Initial skill creation (root node, parentVersion = null)
     *   - 'evolve'   — Content appended from experience feedback
     *   - 'dedup'    — Duplicate detected, version bumped but no content change
     *   - 'retire'   — Skill retired (terminal node)
     *   - 'restore'  — Skill restored from retirement
     *
     * Persistence: Stored alongside the registry in `skill-lineage.json`.
     * @type {Map<string, Array<{ version: string, parentVersion: string|null, type: string, timestamp: string, summary: string, sourceExpId: string|null }>>}
     */
    this._lineage = new Map();
    this._lineagePath = path.join(path.dirname(this.registryPath), 'skill-lineage.json');
    this._loadRegistry();
    this._loadLineage();
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  /**
   * Registers a skill in the registry.
   * Creates the skill file if it doesn't exist.
   *
   * @param {object} options
   * @param {string}   options.name        - Skill identifier (e.g. 'go_crud')
   * @param {string}   options.description - What this skill covers
   * @param {string[]} [options.domains]   - Applicable domains (e.g. ['backend', 'database'])
   * @returns {SkillMeta}
   */
  registerSkill({ name, description, domains = [], type = 'domain-skill', loadLevel = 'task', dependencies = [], maxTokens = null, triggers = {}, filePath = null }) {
    if (this.registry.has(name)) {
      console.log(`[SkillEvolution] Skill already registered: ${name}`);
      return this.registry.get(name);
    }
    const meta = {
      name,
      description,
      domains,
      type,              // domain-skill | troubleshooting | standards | workflow
      loadLevel,         // global | project | task
      dependencies,      // other skill names this skill depends on
      maxTokens: maxTokens || 800,
      triggers,          // { keywords: [], roles: [] }
      version: '1.0.0',
      evolutionCount: 0,
      lastEvolvedAt: null,
      // Skill Lifecycle tracking fields
      usageCount: 0,         // Total times this skill was injected into prompts
      effectiveCount: 0,     // Times injected AND stage passed QualityGate
      lastUsedAt: null,      // ISO timestamp of last injection
      lastEffectiveAt: null, // ISO timestamp of last confirmed effectiveness
      gatePassCount: 0,      // P2: quality gate pass count when skill was injected
      gateFailCount: 0,      // P2: quality gate fail count when skill was injected
      falsePositiveSignals: 0, // P2: noisy/false-positive proxy counter
      policyWeight: 1.0,     // P2: dynamic weight [0.1, 1.0] for skill ranking
      policyStatus: 'active', // P2: active | downweighted | retired
      policyLastUpdatedAt: null,
      retiredAt: null,       // ISO timestamp when retired (null = active)
      filePath: filePath || path.join(this.skillsDir, `${name}.md`),
      createdAt: new Date().toISOString(),
    };
    this.registry.set(name, meta);
    this._saveRegistry();

    // Create skill file if not exists
    if (!fs.existsSync(meta.filePath)) {
      this._createSkillFile(meta);
    }

    // Version DAG: record creation as root node
    this._recordLineage(name, {
      version: meta.version,
      parentVersion: null,
      type: 'create',
      timestamp: meta.createdAt,
      summary: `Initial creation: ${description}`,
      sourceExpId: null,
    });

    console.log(`[SkillEvolution] Skill registered: ${name}`);
    
    // Introspection logging
    introspectionCollector.recordSkill('registered', {
      skillName: name,
      version: meta.version,
      type: meta.type,
      domains: meta.domains,
      loadLevel: meta.loadLevel,
    });
    
    return meta;
  }

  // ─── Capsule Dedup Helpers ────────────────────────────────────────────────────

  /**
   * Computes Jaccard similarity between two strings based on word tokens.
   * Used for title-level dedup: two titles with Jaccard ≥ DEDUP_THRESHOLD are
   * considered to describe the same concept and should be merged, not appended.
   *
   * Why Jaccard on words (not Levenshtein on chars):
   *  - "Use async/await for DB calls" vs "Always use async/await for DB operations"
   *    Levenshtein: 22 edits (high distance → not detected as duplicate)
   *    Jaccard on {use,async,await,db}: intersection=4, union=7 → 0.57 (detected)
   *  - "JWT token expiry handling" vs "Handle JWT expiration"
   *    Jaccard on {jwt,token,expiry,handle,expiration}: intersection=1, union=5 → 0.2
   *    (correctly NOT merged – different enough)
   *
   * @param {string} a
   * @param {string} b
   * @returns {number} 0.0 – 1.0
   */
  _titleSimilarity(a, b) {
    // Normalize: lowercase, strip punctuation, split on whitespace
    const tokenize = s => new Set(
      s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3)
    );
    const setA = tokenize(a);
    const setB = tokenize(b);
    if (setA.size === 0 && setB.size === 0) return 1.0;
    if (setA.size === 0 || setB.size === 0) return 0.0;
    let intersection = 0;
    for (const token of setA) {
      if (setB.has(token)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return intersection / union;
  }

  /**
   * Extracts all entry titles from a given section of a skill file.
   * Returns an array of { title, startIdx } objects for dedup scanning.
   *
   * @param {string} skillContent - Full skill file content
   * @param {string} section      - Section name (e.g. 'Best Practices')
   * @returns {{ title: string, startIdx: number }[]}
   */
  _extractSectionTitles(skillContent, section) {
    const sectionHeader = `## ${section}`;
    const sectionIdx = skillContent.indexOf(sectionHeader);
    if (sectionIdx === -1) return [];

    const afterSection = sectionIdx + sectionHeader.length;
    const nextSectionIdx = skillContent.indexOf('\n## ', afterSection);
    const sectionBody = nextSectionIdx === -1
      ? skillContent.slice(afterSection)
      : skillContent.slice(afterSection, nextSectionIdx);

    const entries = [];
    // Match ### headings (entry titles) within the section
    const headingRegex = /\n### (.+)/g;
    let match;
    while ((match = headingRegex.exec(sectionBody)) !== null) {
      entries.push({
        title: match[1].trim(),
        startIdx: afterSection + match.index,
      });
    }
    return entries;
  }

  /**
   * Evolves a skill by appending new knowledge from an experience.
   * Increments version and records evolution history.
   *
   * Capsule Inheritance (Improvement 3):
   *   Before appending, scans existing entries in the target section for
   *   title-level duplicates using Jaccard word-token similarity.
   *   If a similar entry (similarity ≥ DEDUP_THRESHOLD) is found:
   *     - Skips the append (no duplicate content written)
   *     - Still bumps the version and records the dedup event in Evolution History
   *     - Logs a clear message so the caller knows dedup fired
   *   This prevents the skill file from accumulating semantically identical entries
   *   like "Use async/await for DB calls" / "Always use async/await for DB operations".
   *
   * @param {string} skillName
   * @param {object} evolution
   * @param {string}   evolution.section    - Section to add to (e.g. 'Best Practices', 'Anti-Patterns')
   * @param {string}   evolution.title      - Title of the new entry
   * @param {string}   evolution.content    - Content to add
   * @param {string}   [evolution.sourceExpId] - Source experience ID
   * @param {string}   [evolution.reason]   - Why this evolution was triggered
   * @returns {boolean} true if evolution succeeded
   */
  evolve(skillName, { section, title, content, sourceExpId = null, reason = '' }) {
    const meta = this.registry.get(skillName);
    if (!meta) {
      console.warn(`[SkillEvolution] Skill not found: ${skillName}`);
      return false;
    }

    // Read current skill file (P1-5 fix: use in-memory cache for batch operations)
    let skillContent = '';
    if (this._skillContentCache.has(meta.filePath)) {
      skillContent = this._skillContentCache.get(meta.filePath);
    } else if (fs.existsSync(meta.filePath)) {
      skillContent = fs.readFileSync(meta.filePath, 'utf-8');
    }

    // ── Capsule Inheritance: title-level dedup before appending ──────────────
    // Scan existing entries in the target section for semantically similar titles.
    // Threshold: Jaccard ≥ 0.6 means "same concept, different wording" → skip append.
    const DEDUP_THRESHOLD = 0.6;
    const existingEntries = this._extractSectionTitles(skillContent, section);
    let dedupMatch = null;
    for (const entry of existingEntries) {
      const sim = this._titleSimilarity(title, entry.title);
      if (sim >= DEDUP_THRESHOLD) {
        dedupMatch = { title: entry.title, similarity: sim };
        break;
      }
    }

    if (dedupMatch) {
      // Duplicate detected: bump version and record in history, but skip content append.
      // This keeps the version timeline accurate ("we saw this pattern again") without
      // bloating the file with redundant content.
      console.log(`[SkillEvolution] 🔁 Dedup: "${title}" ≈ "${dedupMatch.title}" (Jaccard=${dedupMatch.similarity.toFixed(2)}) – skipping append, bumping version only.`);

      let [dMajor, dMinor, dPatch] = meta.version.split('.').map(Number);
      dPatch += 1;
      if (dPatch >= 10) { dPatch = 0; dMinor += 1; }
      if (dMinor >= 10) { dMinor = 0; dMajor += 1; }
      const dedupVersion = `${dMajor}.${dMinor}.${dPatch}`;

      // Update version header
      const firstSecIdx = skillContent.indexOf('\n## ');
      const hPart = firstSecIdx === -1 ? skillContent : skillContent.slice(0, firstSecIdx);
      const bPart = firstSecIdx === -1 ? '' : skillContent.slice(firstSecIdx);
      const vPat = /\*\*Version\*\*: \d+\.\d+\.\d+/;
      let updatedContent = vPat.test(hPart)
        ? hPart.replace(vPat, `**Version**: ${dedupVersion}`) + bPart
        : `> **Version**: ${dedupVersion}\n` + hPart + bPart;

      // Append dedup record to Evolution History
      const dedupHistoryEntry = `| v${dedupVersion} | ${new Date().toISOString().slice(0, 10)} | [DEDUP] "${title}" merged into "${dedupMatch.title}" (Jaccard=${dedupMatch.similarity.toFixed(2)}) |`;
      if (updatedContent.includes('## Evolution History')) {
        const hIdx = updatedContent.indexOf('## Evolution History');
        const afterH = updatedContent.indexOf('\n## ', hIdx + 1);
        const hSection = afterH === -1 ? updatedContent.slice(hIdx) : updatedContent.slice(hIdx, afterH);
        const trimmedH = hSection.trimEnd();
        const insertP = hIdx + trimmedH.length;
        updatedContent = updatedContent.slice(0, insertP) + `\n${dedupHistoryEntry}` + updatedContent.slice(insertP);
      } else {
        updatedContent += `\n\n## Evolution History\n\n| Version | Date | Change |\n|---------|------|--------|\n${dedupHistoryEntry}\n`;
      }

      const dedupTmpPath = meta.filePath + '.tmp';
      fs.writeFileSync(dedupTmpPath, updatedContent, 'utf-8');
      fs.renameSync(dedupTmpPath, meta.filePath);
      // P1-5 fix: update content cache
      this._skillContentCache.set(meta.filePath, updatedContent);
      const prevVersion = meta.version;
      meta.version = dedupVersion;
      meta.evolutionCount += 1;
      meta.lastEvolvedAt = new Date().toISOString();
      this._saveRegistry();

      // Version DAG: record dedup event
      this._recordLineage(skillName, {
        version: dedupVersion,
        parentVersion: prevVersion,
        type: 'dedup',
        timestamp: meta.lastEvolvedAt,
        summary: `Dedup: "${title}" merged into "${dedupMatch.title}" (Jaccard=${dedupMatch.similarity.toFixed(2)})`,
        sourceExpId,
      });

      return true;
    }

    // Compute new version (do NOT mutate meta yet – write file first, then update registry)
    // N30 fix: mutating meta before writeFileSync means a crash between the two leaves
    // registry version ahead of the actual file content. Compute values first, apply after.
    // N53 fix: implement patch→minor→major carry-over so version numbers stay semantic.
    // patch rolls over at 10 (0–9), minor rolls over at 10 (0–9), major increments beyond.
    let [major, minor, patch] = meta.version.split('.').map(Number);
    patch += 1;
    if (patch >= 10) { patch = 0; minor += 1; }
    if (minor >= 10) { minor = 0; major += 1; }
    const newVersion = `${major}.${minor}.${patch}`;

    // Build evolution entry
    const evolutionEntry = [
      ``,
      `### ${title}`,
      ``,
      content,
      ``,
      `> *Added in v${newVersion} | ${new Date().toISOString().slice(0, 10)}${sourceExpId ? ` | Source: ${sourceExpId}` : ''}*`,
    ].join('\n');

    // Append to the appropriate section or create it
    const sectionHeader = `## ${section}`;
    if (skillContent.includes(sectionHeader)) {
      // Find the section and append before the next ## heading
      const sectionIdx = skillContent.indexOf(sectionHeader);
      const nextSectionIdx = skillContent.indexOf('\n## ', sectionIdx + sectionHeader.length);
      if (nextSectionIdx === -1) {
        skillContent = skillContent + evolutionEntry;
      } else {
        skillContent = skillContent.slice(0, nextSectionIdx) + evolutionEntry + skillContent.slice(nextSectionIdx);
      }
    } else {
      // Create new section
      skillContent += `\n\n${sectionHeader}\n${evolutionEntry}`;
    }

    // Update version header (only in the metadata block at the top, before first ##).
    // N25 fix: if the header block doesn't contain a version line (non-standard format),
    // prepend the version line to the file instead of silently skipping the update.
    const firstSectionIdx = skillContent.indexOf('\n## ');
    const headerPart = firstSectionIdx === -1 ? skillContent : skillContent.slice(0, firstSectionIdx);
    const bodyPart   = firstSectionIdx === -1 ? '' : skillContent.slice(firstSectionIdx);
    const versionPattern = /\*\*Version\*\*: \d+\.\d+\.\d+/;
    if (versionPattern.test(headerPart)) {
      // Replace the first (and only expected) version line in the header block
      skillContent = headerPart.replace(versionPattern, `**Version**: ${newVersion}`) + bodyPart;
    } else {
      // Header block has no version line – prepend one so future evolutions can find it
      skillContent = `> **Version**: ${newVersion}\n` + headerPart + bodyPart;
    }

    // Append to evolution history.
    // N14 fix: the old approach used replace(/## Evolution History\n/, ...) which inserted
    // the new row BEFORE the table header row, corrupting the Markdown table format.
    // Correct approach: find the end of the history table and append the new row there.
    const historyEntry = `| v${newVersion} | ${new Date().toISOString().slice(0, 10)} | ${reason || title} |`;
    if (skillContent.includes('## Evolution History')) {
      // Find the last table row in the Evolution History section and append after it.
      // The history section ends at the next ## heading or EOF.
      const historyIdx = skillContent.indexOf('## Evolution History');
      const afterHistory = skillContent.indexOf('\n## ', historyIdx + 1);
      const historySection = afterHistory === -1
        ? skillContent.slice(historyIdx)
        : skillContent.slice(historyIdx, afterHistory);

      // Find the last non-empty line in the history section to append after it
      const trimmedSection = historySection.trimEnd();
      const insertPos = historyIdx + trimmedSection.length;
      skillContent = skillContent.slice(0, insertPos) + `\n${historyEntry}` + skillContent.slice(insertPos);
    } else {
      skillContent += `\n\n## Evolution History\n\n| Version | Date | Change |\n|---------|------|--------|\n${historyEntry}\n`;
    }

    // N30 fix: only update meta AFTER the file write succeeds, so registry stays
    // consistent with the actual file content even if writeFileSync throws.
    // N48 fix: use atomic write for the skill .md file (write to .tmp then rename)
    // so a process crash during write does not leave a corrupted skill file.
    const skillTmpPath = meta.filePath + '.tmp';
    fs.writeFileSync(skillTmpPath, skillContent, 'utf-8');
    fs.renameSync(skillTmpPath, meta.filePath);
    // P1-5 fix: update content cache after successful write
    this._skillContentCache.set(meta.filePath, skillContent);
    const oldVersion = meta.version;
    meta.version = newVersion;
    meta.evolutionCount += 1;
    meta.lastEvolvedAt = new Date().toISOString();
    this._saveRegistry();

    // Version DAG: record evolution event
    this._recordLineage(skillName, {
      version: newVersion,
      parentVersion: oldVersion,
      type: 'evolve',
      timestamp: meta.lastEvolvedAt,
      summary: `${section}: ${title}${reason ? ` (${reason})` : ''}`,
      sourceExpId,
    });

    console.log(`[SkillEvolution] ✨ Skill evolved: ${skillName} → v${meta.version} (${reason || title})`);
    
    // Introspection logging
    introspectionCollector.recordSkill('evolved', {
      skillName,
      oldVersion,
      newVersion: meta.version,
      evolutionCount: meta.evolutionCount,
      sourceExpId,
      section,
      title,
      deduped: false,
    });

    // LLM-Lite: Post-evolve refinement via cheap LLM model.
    // Consolidates bloated skills that have accumulated many evolutions.
    // Uses cheapLlmCall (GPT-4o-mini tier) — ~$0.002/call, non-blocking.
    // ADR-37: LLM is enhancement, not dependency (graceful fallback on failure).
    if (this._llmRefiner) {
      const currentContent = this._skillContentCache.get(meta.filePath) || skillContent;
      if (this._llmRefiner.shouldRefine(meta, currentContent)) {
        this._llmRefiner.refineSkill(meta, currentContent).then(refined => {
          if (refined) {
            const refineTmpPath = meta.filePath + '.tmp';
            fs.writeFileSync(refineTmpPath, refined, 'utf-8');
            fs.renameSync(refineTmpPath, meta.filePath);
            this._skillContentCache.set(meta.filePath, refined);

            this._recordLineage(skillName, {
              version: meta.version,
              parentVersion: meta.version,
              type: 'refine',
              timestamp: new Date().toISOString(),
              summary: `LLM-Lite refinement: consolidated ${meta.evolutionCount} evolutions`,
              sourceExpId: null,
            });

            console.log(`[SkillEvolution] 🧠 LLM-Lite refinement applied to "${skillName}"`);
          }
        }).catch(err => {
          console.warn(`[SkillEvolution] LLM-Lite refinement failed (non-fatal): ${err.message}`);
        });
      }
    }
    
    return true;
  }

  /**
   * Injects the LLM-Lite Skill Refiner.
   * Called from Orchestrator when _rawLlmCall becomes available.
   *
   * @param {import('./skill-llm-refiner').SkillLlmRefiner} refiner
   */
  setLlmRefiner(refiner) {
    this._llmRefiner = refiner;
    console.log(`[SkillEvolution] 🧠 LLM-Lite Skill Refiner injected`);
  }

  /**
   * Reads a skill file and returns its content.
   *
   * @param {string} skillName
   * @returns {string|null}
   */
  readSkill(skillName) {
    const meta = this.registry.get(skillName);
    if (!meta || !fs.existsSync(meta.filePath)) return null;
    return fs.readFileSync(meta.filePath, 'utf-8');
  }

  /**
   * Lists all registered skills with their metadata.
   *
   * @returns {SkillMeta[]}
   */
  listSkills() {
    return Array.from(this.registry.values());
  }

  /**
   * Returns skills relevant to a given domain or task context.
   *
   * @param {string[]} domains - Domain keywords to match
   * @returns {SkillMeta[]}
   */
  getRelevantSkills(domains = []) {
    if (domains.length === 0) return this.listSkills();
    return this.listSkills().filter(skill =>
      skill.domains.some(d => domains.some(q => d.toLowerCase().includes(q.toLowerCase())))
    );
  }

  /**
   * Returns statistics about all skills.
   *
   * @returns {object}
   */
  getStats() {
    const skills = this.listSkills();
    const totalEvolutions = skills.reduce((sum, s) => sum + s.evolutionCount, 0);
    return {
      totalSkills: skills.length,
      totalEvolutions,
      // N71 fix: sort a shallow copy so the original array order is not mutated.
      mostEvolved: skills.slice().sort((a, b) => b.evolutionCount - a.evolutionCount).slice(0, 3),
    };
  }

  /**
   * Returns a Set of skill names that are currently retired.
   * Used by ContextLoader to exclude retired skills from injection.
   *
   * @returns {Set<string>}
   */
  getRetiredSkillNames() {
    const retired = new Set();
    for (const meta of this.registry.values()) {
      if (meta.retiredAt) retired.add(meta.name);
    }
    return retired;
  }

  // ─── Skill Lifecycle Management ─────────────────────────────────────────────

  /**
   * Records that a skill was injected into an agent prompt.
   * Called from Observability/flush or from a lifecycle hook.
   *
   * @param {string} skillName
   * @param {number} [count=1] - Number of injections to record
   */
  recordUsage(skillName, count = 1) {
    const meta = this.registry.get(skillName);
    if (!meta) return;
    meta.usageCount = (meta.usageCount || 0) + count;
    meta.lastUsedAt = new Date().toISOString();
    // Do not save immediately – batch via flushLifecycleStats()
  }

  /**
   * Records that a skill was confirmed effective (stage passed after injection).
   *
   * @param {string} skillName
   */
  recordEffective(skillName) {
    const meta = this.registry.get(skillName);
    if (!meta) return;
    meta.effectiveCount = (meta.effectiveCount || 0) + 1;
    meta.lastEffectiveAt = new Date().toISOString();
  }

  /**
   * P2: Records quality gate outcome signals for a skill.
   *
   * @param {string} skillName
   * @param {object} [options]
   * @param {boolean} [options.passed=true]
   * @param {number} [options.falsePositiveSignals=0]
   */
  recordGateOutcome(skillName, { passed = true, falsePositiveSignals = 0 } = {}) {
    const meta = this.registry.get(skillName);
    if (!meta) return;

    if (passed) {
      meta.gatePassCount = (meta.gatePassCount || 0) + 1;
    } else {
      meta.gateFailCount = (meta.gateFailCount || 0) + 1;
    }
    if (falsePositiveSignals > 0) {
      meta.falsePositiveSignals = (meta.falsePositiveSignals || 0) + Number(falsePositiveSignals || 0);
    }
    meta.policyLastUpdatedAt = new Date().toISOString();
  }

  /**
   * Persists accumulated lifecycle stats to the registry file.
   * Call at the end of a session (e.g. from Orchestrator shutdown).
   */
  flushLifecycleStats() {
    this._saveRegistry();
  }

  /**
   * P2: Applies effectiveness policy to auto-downweight/retire noisy skills.
   *
   * Criteria:
   * - Low adoption: effectiveCount / usageCount below threshold
   * - High noise: falsePositiveSignals / (gatePassCount + gateFailCount) above threshold
   *
   * @param {object} [options]
   * @param {number} [options.minUsage=5]
   * @param {number} [options.lowAdoptionThreshold=0.25]
   * @param {number} [options.highFalsePositiveRate=0.6]
   * @param {number} [options.minFalsePositiveSignals=3]
   * @param {number} [options.downweightStep=0.2]
   * @param {number} [options.minPolicyWeight=0.1]
   * @param {number} [options.retireWeightThreshold=0.35]
   * @param {number} [options.retireGateFailThreshold=4]
   * @returns {{ downweighted: object[], retired: object[] }}
   */
  applyEffectivenessPolicy({
    minUsage = 5,
    lowAdoptionThreshold = 0.25,
    highFalsePositiveRate = 0.6,
    minFalsePositiveSignals = 3,
    downweightStep = 0.2,
    minPolicyWeight = 0.1,
    retireWeightThreshold = 0.35,
    retireGateFailThreshold = 4,
  } = {}) {
    const downweighted = [];
    const retired = [];
    let changed = false;

    for (const meta of this.registry.values()) {
      if (meta.retiredAt) continue;

      const usage = meta.usageCount || 0;
      if (usage < minUsage) continue;

      const effective = meta.effectiveCount || 0;
      const adoptionRate = effective / Math.max(usage, 1);

      const gatePass = meta.gatePassCount || 0;
      const gateFail = meta.gateFailCount || 0;
      const gateTotal = gatePass + gateFail;
      const fpSignals = meta.falsePositiveSignals || 0;
      const falsePositiveRate = fpSignals / Math.max(gateTotal, 1);

      const lowAdoption = adoptionRate < lowAdoptionThreshold;
      const highNoise = falsePositiveRate >= highFalsePositiveRate && fpSignals >= minFalsePositiveSignals;
      if (!lowAdoption || !highNoise) continue;

      const oldWeight = Number(meta.policyWeight || 1);
      const newWeight = Math.max(minPolicyWeight, +(oldWeight - downweightStep).toFixed(3));

      if (newWeight < oldWeight) {
        meta.policyWeight = newWeight;
        meta.policyStatus = 'downweighted';
        meta.policyLastUpdatedAt = new Date().toISOString();
        changed = true;
        downweighted.push({
          name: meta.name,
          oldWeight,
          newWeight,
          adoptionRate: +adoptionRate.toFixed(3),
          falsePositiveRate: +falsePositiveRate.toFixed(3),
          falsePositiveSignals: fpSignals,
        });
      }

      const canRetire = meta.loadLevel !== 'global' && meta.loadLevel !== 'project';
      if (canRetire && newWeight <= retireWeightThreshold && gateFail >= retireGateFailThreshold) {
        meta.retiredAt = new Date().toISOString();
        meta.policyStatus = 'retired';
        meta.policyLastUpdatedAt = meta.retiredAt;
        changed = true;
        retired.push({
          name: meta.name,
          adoptionRate: +adoptionRate.toFixed(3),
          falsePositiveRate: +falsePositiveRate.toFixed(3),
          gateFailCount: gateFail,
        });
      }
    }

    if (changed) {
      this._saveRegistry();
    }

    return { downweighted, retired };
  }

  /**
   * Identifies and optionally retires stale skills.
   *
   * A skill is considered stale if ALL of the following are true:
   *   1. usageCount ≥ minUsage (enough data to judge)
   *   2. effectiveCount / usageCount < effectivenessThreshold
   *   3. Not used in the last staleDays days
   *   4. Not a global/project skill (only task-level skills can be retired)
   *
   * Retired skills are:
   *   - Marked with retiredAt timestamp in registry
   *   - NOT deleted from disk (can be manually restored)
   *   - Excluded from ContextLoader keyword matching (via retiredAt check)
   *
   * @param {object} [options]
   * @param {number}  [options.minUsage=10]              - Minimum injection count before judging
   * @param {number}  [options.effectivenessThreshold=0.1] - Below this hit-rate = stale
   * @param {number}  [options.staleDays=30]             - Days since last use to consider stale
   * @param {boolean} [options.dryRun=true]              - If true, only report; don't retire
   * @returns {{ stale: SkillMeta[], retired: SkillMeta[], report: string }}
   */
  retireStaleSkills({
    minUsage = 10,
    effectivenessThreshold = 0.1,
    staleDays = 30,
    dryRun = true,
  } = {}) {
    const now = Date.now();
    const staleThresholdMs = staleDays * 24 * 60 * 60 * 1000;
    const stale = [];
    const retired = [];

    for (const meta of this.registry.values()) {
      // Skip already retired skills
      if (meta.retiredAt) continue;
      // Skip global/project skills – these are deliberately configured
      if (meta.loadLevel === 'global' || meta.loadLevel === 'project') continue;
      // Skip skills without enough usage data
      const usage = meta.usageCount || 0;
      if (usage < minUsage) continue;

      const effective = meta.effectiveCount || 0;
      const hitRate = effective / usage;
      const lastUsed = meta.lastUsedAt ? new Date(meta.lastUsedAt).getTime() : 0;
      const daysSinceUse = (now - lastUsed) / (24 * 60 * 60 * 1000);

      if (hitRate < effectivenessThreshold && daysSinceUse > staleDays) {
        stale.push(meta);
        if (!dryRun) {
          // LLM-Lite: Attempt to fix the skill before retiring it.
          // Uses cheapLlmCall (GPT-4o-mini tier) — ~$0.003/call.
          // If the refiner recommends a fix, apply it instead of retiring.
          // ADR-37: LLM is enhancement, not dependency (graceful fallback).
          if (this._llmRefiner && this._llmRefiner.shouldFix(meta)) {
            const skillContent = this.readSkill(meta.name);
            if (skillContent) {
              this._llmRefiner.fixSkill(meta, skillContent).then(result => {
                if (result && result.action === 'fix' && result.content) {
                  const fixTmpPath = meta.filePath + '.tmp';
                  fs.writeFileSync(fixTmpPath, result.content, 'utf-8');
                  fs.renameSync(fixTmpPath, meta.filePath);
                  this._skillContentCache.set(meta.filePath, result.content);
                  meta.retiredAt = null; // Un-retire
                  this._recordLineage(meta.name, {
                    version: meta.version,
                    parentVersion: meta.version,
                    type: 'restore',
                    timestamp: new Date().toISOString(),
                    summary: `LLM-Lite fix restored skill from retirement (hitRate=${(hitRate * 100).toFixed(0)}%)`,
                    sourceExpId: null,
                  });
                  this._saveRegistry();
                  console.log(`[SkillEvolution] 🔧 LLM-Lite fix restored "${meta.name}" from retirement`);
                }
              }).catch(() => { /* Non-fatal: skill stays retired */ });
            }
          }

          meta.retiredAt = new Date().toISOString();
          retired.push(meta);

          // Version DAG: record retirement
          this._recordLineage(meta.name, {
            version: meta.version,
            parentVersion: meta.version,
            type: 'retire',
            timestamp: meta.retiredAt,
            summary: `Retired: hitRate=${(hitRate * 100).toFixed(0)}%, lastUsed=${Math.round(daysSinceUse)}d ago`,
            sourceExpId: null,
          });

          console.log(`[SkillEvolution] 📦 Retired stale skill: ${meta.name} (hitRate=${(hitRate * 100).toFixed(0)}%, lastUsed=${Math.round(daysSinceUse)}d ago)`);
        }
      }
    }

    if (!dryRun && retired.length > 0) {
      this._saveRegistry();
    }

    const report = stale.length === 0
      ? '✅ No stale skills detected.'
      : stale.map(s => {
          const hr = ((s.effectiveCount || 0) / (s.usageCount || 1) * 100).toFixed(0);
          return `  - ${s.name}: ${hr}% effective (${s.usageCount} uses, ${s.effectiveCount || 0} effective)${s.retiredAt ? ' [RETIRED]' : ' [STALE]'}`;
        }).join('\n');

    return { stale, retired, report };
  }

  /**
   * Generates a comprehensive lifecycle report for all skills.
   *
   * @returns {object} Report with per-skill metrics and aggregate stats
   */
  getLifecycleReport() {
    const skills = this.listSkills();
    const active = skills.filter(s => !s.retiredAt);
    const retired = skills.filter(s => s.retiredAt);

    const perSkill = skills.map(s => {
      const usage = s.usageCount || 0;
      const effective = s.effectiveCount || 0;
      const gatePass = s.gatePassCount || 0;
      const gateFail = s.gateFailCount || 0;
      const fpSignals = s.falsePositiveSignals || 0;
      return {
        name: s.name,
        type: s.type,
        loadLevel: s.loadLevel,
        version: s.version,
        evolutionCount: s.evolutionCount || 0,
        usageCount: usage,
        effectiveCount: effective,
        hitRate: usage > 0 ? +(effective / usage).toFixed(3) : null,
        gatePassCount: gatePass,
        gateFailCount: gateFail,
        falsePositiveSignals: fpSignals,
        falsePositiveRate: (gatePass + gateFail) > 0 ? +(fpSignals / (gatePass + gateFail)).toFixed(3) : null,
        policyWeight: Number(s.policyWeight || 1),
        policyStatus: s.policyStatus || (s.retiredAt ? 'retired' : 'active'),
        policyLastUpdatedAt: s.policyLastUpdatedAt || null,
        lastUsedAt: s.lastUsedAt || null,
        lastEffectiveAt: s.lastEffectiveAt || null,
        retiredAt: s.retiredAt || null,
        createdAt: s.createdAt || null,
        status: s.retiredAt ? 'retired' : (usage === 0 ? 'unused' : (effective / Math.max(usage, 1) >= 0.3 ? 'healthy' : 'underperforming')),
      };
    });

    return {
      summary: {
        total: skills.length,
        active: active.length,
        retired: retired.length,
        unused: perSkill.filter(s => s.status === 'unused').length,
        healthy: perSkill.filter(s => s.status === 'healthy').length,
        underperforming: perSkill.filter(s => s.status === 'underperforming').length,
      },
      skills: perSkill.sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0)),
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────────

  /**
   * Creates a new skill file with standard template.
   *
   * @param {SkillMeta} meta
   */
  _createSkillFile(meta) {
    // Build YAML frontmatter with structured metadata
    const triggerKeywords = (meta.triggers && meta.triggers.keywords) || [];
    const triggerRoles = (meta.triggers && meta.triggers.roles) || [];
    const frontmatter = [
      `---`,
      `name: ${meta.name}`,
      `version: ${meta.version}`,
      `type: ${meta.type || 'domain-skill'}`,
      `domains: [${(meta.domains || []).join(', ')}]`,
      `dependencies: [${(meta.dependencies || []).join(', ')}]`,
      `load_level: ${meta.loadLevel || 'task'}`,
      `max_tokens: ${meta.maxTokens || 800}`,
      `triggers:`,
      `  keywords: [${triggerKeywords.join(', ')}]`,
      `  roles: [${triggerRoles.join(', ')}]`,
      `description: "${meta.description}"`,
      `---`,
    ].join('\n');

    // ── Determine sections based on skill type ──────────────────────────────
    // ECC-inspired improvement: each section now includes a brief PURPOSE comment
    // (wrapped in <!-- -->) so that both human editors and the LLM enrichment
    // pipeline understand WHAT kind of content belongs in each section.
    // This dramatically improves enrichment quality because the LLM can read
    // these purpose comments and generate more targeted content.
    let sections;
    if (meta.type === 'troubleshooting') {
      sections = [
        `## Common Errors`,
        `<!-- PURPOSE: Document specific error messages, stack traces, and symptoms that developers encounter. Each entry should include the exact error text and a brief description of when it occurs. -->`,
        ``,
        `_No errors documented yet. Errors will be added from complaint resolutions._`,
        ``,
        `## Root Cause Analysis`,
        `<!-- PURPOSE: Explain WHY each common error occurs at a technical level. Link symptoms to underlying causes (misconfiguration, race condition, version incompatibility, etc.). -->`,
        ``,
        `_No root causes documented yet._`,
        ``,
        `## Fix Recipes`,
        `<!-- PURPOSE: Step-by-step fix instructions for each error. Must be copy-paste actionable: "1. Open X, 2. Change Y to Z, 3. Verify by running W". -->`,
        ``,
        `_No fix recipes documented yet._`,
        ``,
        `## Prevention Rules`,
        `<!-- PURPOSE: Prescriptive rules that PREVENT errors from occurring in the first place. Written as imperatives: "Always X", "Never Y", "Before doing Z, check W". -->`,
        ``,
        `_No prevention rules defined yet._`,
      ];
    } else if (meta.type === 'standards') {
      sections = [
        `## Coding Standards`,
        `<!-- PURPOSE: Language-specific coding rules enforced across the project. Each rule should be testable (a linter or reviewer can verify compliance). -->`,
        ``,
        `_No coding standards defined yet._`,
        ``,
        `## Naming Conventions`,
        `<!-- PURPOSE: Naming patterns for files, variables, functions, classes, constants, and database entities. Include examples for each pattern. -->`,
        ``,
        `_No naming conventions defined yet._`,
        ``,
        `## Directory Structure`,
        `<!-- PURPOSE: Expected project layout rules. Describe where different types of files should live and why. -->`,
        ``,
        `_No directory structure rules defined yet._`,
        ``,
        `## Commit Conventions`,
        `<!-- PURPOSE: Git commit message format, branch naming, PR title conventions. Include templates and examples. -->`,
        ``,
        `_No commit conventions defined yet._`,
      ];
    } else {
      sections = [
        `## Rules`,
        `<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. Rules are the highest-authority content in a skill — they override best practices when in conflict. -->`,
        ``,
        `_No rules defined yet. Rules will be added as experience accumulates._`,
        ``,
        `## SOP (Standard Operating Procedure)`,
        `<!-- PURPOSE: Step-by-step workflow for the skill's domain. Numbered phases with clear entry/exit criteria. An agent following this SOP should produce consistent, high-quality output regardless of the specific project. -->`,
        ``,
        `_No SOP defined yet._`,
        ``,
        `## Checklist`,
        `<!-- PURPOSE: A verification checklist to run AFTER completing work. Each item is a yes/no question or a checkbox assertion. Group items by concern (correctness, security, performance, maintainability). -->`,
        ``,
        `_No checklist defined yet._`,
        ``,
        `## Best Practices`,
        `<!-- PURPOSE: Recommended patterns that SHOULD be followed. Unlike Rules (which are mandatory), Best Practices are advisory — they can be overridden with justification. Each entry explains WHAT to do and WHY it helps. -->`,
        ``,
        `_No best practices defined yet._`,
        ``,
        `## Anti-Patterns`,
        `<!-- PURPOSE: Common MISTAKES to avoid. Each entry describes: (1) the wrong approach, (2) why it's wrong, (3) the correct alternative. Use a table format: ❌ Anti-Pattern | ✅ Correct Approach. -->`,
        ``,
        `_No anti-patterns defined yet._`,
        ``,
        `## Gotchas`,
        `<!-- PURPOSE: Environment/version/platform-SPECIFIC traps that are NOT general anti-patterns. A gotcha is something that works in one context but breaks in another (e.g. "Works in Node 18 but fails in Node 20 due to X"). -->`,
        ``,
        `_No gotchas documented yet. Environment/version/platform-specific pitfalls will appear here._`,
        ``,
        `## Context Hints`,
        `<!-- PURPOSE: Background knowledge that helps an agent make better decisions. Not rules or practices — just useful context (e.g. "This project uses X library which has a known limitation Y", "The team prefers Z approach for historical reasons"). -->`,
        ``,
        `_No context hints defined yet._`,
        ``,
        `## Code Snippets`,
        `<!-- PURPOSE: Reusable code patterns, utility function signatures, and common implementation templates for this skill's domain. Each snippet should be copy-paste ready and include a brief description of WHEN to use it. Populated automatically from high-frequency utility_class and code_snippet experiences. -->`,
        ``,
        `_No code snippets collected yet. Snippets will be added from utility class scanning and experience evolution._`,
      ];
    }

    const content = [
      frontmatter,
      ``,
      `# Skill: ${meta.name}`,
      ``,
      `> **Version**: ${meta.version}`,
      `> **Description**: ${meta.description}`,
      `> **Domains**: ${(meta.domains || []).join(', ') || 'general'}`,
      ``,
      `---`,
      ``,
      ...sections,
      ``,
      `## Evolution History`,
      ``,
      `| Version | Date | Change |`,
      `|---------|------|--------|`,
      `| v1.0.0 | ${new Date().toISOString().slice(0, 10)} | Initial creation |`,
      ``,
      `---`,
      ``,
      `<!-- KNOWLEDGE_SOURCES -->
<!-- 
  This skill can be auto-enriched with knowledge from:
  
  1. AgentHub Knowledge Base (UUID: 86d363ab81634904b1cbc1b46acc66bc)
     - Use MCP tool: knowledge.knowledgebase_search
     - Query: "${meta.description} best practices patterns"
     - Domains: ${(meta.domains || []).join(', ') || 'software development'}
  
  2. Web Search + LLM Analysis
     - Automatically triggered via enrichSkillFromExternalKnowledge()
     - When WebSearch MCP adapter is available
  
  To manually enrich this skill, run:
  > /wf enrich-skill ${meta.name}
-->`,
    ].join('\n');

    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
    // N48 fix: atomic write – write to .tmp first, then rename over the target.
    const tmpPath = meta.filePath + '.tmp';
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, meta.filePath);
    console.log(`[SkillEvolution] Skill file created: ${meta.filePath}`);

    // ADR-29: Notify listeners that a placeholder skill was created.
    // The Orchestrator can hook into this to trigger external knowledge enrichment.
    if (typeof this.onSkillFileCreated === 'function') {
      try {
        this.onSkillFileCreated(meta);
      } catch (hookErr) {
        console.warn(`[SkillEvolution] onSkillFileCreated hook error (non-fatal): ${hookErr.message}`);
      }
    }
  }

  /**
   * Parses YAML frontmatter from a skill file content.
   * Delegates to shared yaml-frontmatter.js to eliminate duplication.
   *
   * @param {string} content - Skill file content
   * @returns {{ meta: object, bodyStart: number }|null}
   */
  _parseFrontmatter(content) {
    const { parseFrontmatter } = require('./yaml-frontmatter');
    if (!content || !content.startsWith('---')) return null;
    const result = parseFrontmatter(content);
    if (!result.bodyStart && Object.keys(result.meta).length === 0) return null;
    return { meta: result.meta, bodyStart: result.bodyStart };
  }

  /**
   * Parses a simple YAML value (string, number, array).
   * Delegates to shared yaml-frontmatter.js.
   * @param {string} val
   * @returns {*}
   */
  _parseYamlValue(val) {
    const { parseYamlValue } = require('./yaml-frontmatter');
    return parseYamlValue(val);
  }

  _loadRegistry() {
    try {
      if (fs.existsSync(this.registryPath)) {
        const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
        for (const skill of data) {
          this.registry.set(skill.name, skill);
        }
        console.log(`[SkillEvolution] Loaded ${this.registry.size} skills from registry`);
      }
    } catch (err) {
      console.warn(`[SkillEvolution] Could not load skill registry: ${err.message}`);
    }
  }

  _saveRegistry() {
    try {
      const dir = path.dirname(this.registryPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // N37 fix: atomic write – write to a .tmp file first, then rename over the target.
      const tmpPath = this.registryPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(Array.from(this.registry.values()), null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.registryPath);
    } catch (err) {
      console.warn(`[SkillEvolution] Could not save skill registry: ${err.message}`);
    }
  }

  // ─── Version DAG (ADR-OpenSpace) ──────────────────────────────────────────

  /**
   * Records a lineage node for a skill evolution event.
   *
   * @param {string} skillName
   * @param {{ version: string, parentVersion: string|null, type: string, timestamp: string, summary: string, sourceExpId: string|null }} node
   * @private
   */
  _recordLineage(skillName, node) {
    if (!this._lineage.has(skillName)) {
      this._lineage.set(skillName, []);
    }
    this._lineage.get(skillName).push(node);
    this._saveLineage();
  }

  /**
   * Loads the lineage DAG from disk.
   * @private
   */
  _loadLineage() {
    try {
      if (fs.existsSync(this._lineagePath)) {
        const data = JSON.parse(fs.readFileSync(this._lineagePath, 'utf-8'));
        this._lineage = new Map(Object.entries(data));
        const totalNodes = Array.from(this._lineage.values()).reduce((sum, nodes) => sum + nodes.length, 0);
        console.log(`[SkillEvolution] 🌳 Loaded lineage DAG: ${this._lineage.size} skills, ${totalNodes} nodes`);
      }
    } catch (err) {
      console.warn(`[SkillEvolution] Could not load lineage DAG: ${err.message}`);
    }
  }

  /**
   * Persists the lineage DAG to disk.
   * @private
   */
  _saveLineage() {
    try {
      const dir = path.dirname(this._lineagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = Object.fromEntries(this._lineage);
      const tmpPath = this._lineagePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this._lineagePath);
    } catch (err) {
      console.warn(`[SkillEvolution] Could not save lineage DAG: ${err.message}`);
    }
  }

  /**
   * Returns the full lineage (version history DAG) for a skill.
   *
   * @param {string} skillName
   * @returns {Array<{ version: string, parentVersion: string|null, type: string, timestamp: string, summary: string, sourceExpId: string|null }>}
   */
  getLineage(skillName) {
    return this._lineage.get(skillName) || [];
  }

  /**
   * Returns a formatted lineage report for a skill (human-readable).
   *
   * @param {string} skillName
   * @returns {string}
   */
  getLineageReport(skillName) {
    const nodes = this.getLineage(skillName);
    if (nodes.length === 0) return `No lineage data for skill: ${skillName}`;

    const lines = [
      `## 🌳 Version Lineage: ${skillName}`,
      '',
      '| Version | Parent | Type | Date | Summary |',
      '|---------|--------|------|------|---------|',
    ];

    for (const node of nodes) {
      const date = node.timestamp ? node.timestamp.slice(0, 10) : 'unknown';
      const parent = node.parentVersion || '—';
      lines.push(`| v${node.version} | v${parent} | ${node.type} | ${date} | ${node.summary.slice(0, 80)} |`);
    }

    // Compute lineage stats
    const types = {};
    for (const node of nodes) {
      types[node.type] = (types[node.type] || 0) + 1;
    }
    lines.push('');
    lines.push(`**Stats**: ${nodes.length} versions — ${Object.entries(types).map(([t, c]) => `${c} ${t}`).join(', ')}`);

    return lines.join('\n');
  }

  /**
   * Returns lineage statistics across all skills.
   *
   * @returns {{ totalSkills: number, totalNodes: number, byType: object, deepestLineage: { skill: string, depth: number } }}
   */
  getLineageStats() {
    const byType = {};
    let totalNodes = 0;
    let deepestSkill = '';
    let deepestDepth = 0;

    for (const [skillName, nodes] of this._lineage) {
      totalNodes += nodes.length;
      if (nodes.length > deepestDepth) {
        deepestDepth = nodes.length;
        deepestSkill = skillName;
      }
      for (const node of nodes) {
        byType[node.type] = (byType[node.type] || 0) + 1;
      }
    }

    return {
      totalSkills: this._lineage.size,
      totalNodes,
      byType,
      deepestLineage: { skill: deepestSkill, depth: deepestDepth },
    };
  }

  // ─── P0-B: OpenSpace-Inspired Health Metrics & Auto-Evolution Triggers ─────
  //
  // Ported from OpenSpace's SkillEvolver._diagnose_skill_health() and
  // process_metric_check(). Adds 4-dimensional quality metrics tracking
  // (appliedRate, completionRate, effectiveRate, fallbackRate) and
  // rule-based health diagnosis with relaxed thresholds.

  /**
   * Records that a skill was selected but NOT applied (fallback).
   * OpenSpace metric: fallback_rate = fallbacks / selections.
   *
   * @param {string} skillName
   */
  recordFallback(skillName) {
    const meta = this.registry.get(skillName);
    if (!meta) return;
    meta.totalSelections = (meta.totalSelections || 0) + 1;
    meta.totalFallbacks = (meta.totalFallbacks || 0) + 1;
  }

  /**
   * Records that a skill was selected AND applied (used in the task).
   * OpenSpace metric: applied_rate = applied / selections.
   *
   * @param {string} skillName
   */
  recordApplied(skillName) {
    const meta = this.registry.get(skillName);
    if (!meta) return;
    meta.totalSelections = (meta.totalSelections || 0) + 1;
    meta.totalApplied = (meta.totalApplied || 0) + 1;
  }

  /**
   * Records that a skill-applied task completed successfully.
   * OpenSpace metric: completion_rate = completions / applied.
   *
   * @param {string} skillName
   */
  recordCompletion(skillName) {
    const meta = this.registry.get(skillName);
    if (!meta) return;
    meta.totalCompletions = (meta.totalCompletions || 0) + 1;
  }

  /**
   * Computes the 4-dimensional health metrics for a skill.
   * Mirrors OpenSpace's SkillRecord computed properties.
   *
   * @param {string} skillName
   * @returns {{ appliedRate: number, completionRate: number, effectiveRate: number, fallbackRate: number, totalSelections: number } | null}
   */
  getHealthMetrics(skillName) {
    const meta = this.registry.get(skillName);
    if (!meta) return null;

    const selections = meta.totalSelections || 0;
    const applied = meta.totalApplied || 0;
    const completions = meta.totalCompletions || 0;
    const fallbacks = meta.totalFallbacks || 0;

    return {
      appliedRate: selections > 0 ? applied / selections : 0,
      completionRate: applied > 0 ? completions / applied : 0,
      effectiveRate: selections > 0 ? completions / selections : 0,
      fallbackRate: selections > 0 ? fallbacks / selections : 0,
      totalSelections: selections,
    };
  }

  /**
   * Diagnoses what type of evolution a skill needs based on health metrics.
   *
   * Ported from OpenSpace's SkillEvolver._diagnose_skill_health().
   * Thresholds are intentionally relaxed — the LLM confirmation step
   * (in skill-llm-refiner.js) filters out false positives.
   *
   * @param {string} skillName
   * @returns {{ type: string|null, direction: string }}
   *   type: 'fix' | 'derived' | null
   *   direction: Human-readable explanation of why evolution is needed
   */
  diagnoseSkillHealth(skillName) {
    const metrics = this.getHealthMetrics(skillName);
    if (!metrics || metrics.totalSelections < 5) {
      return { type: null, direction: '' };
    }

    // Relaxed thresholds (OpenSpace pattern: wide screening + LLM confirmation)
    const FALLBACK_THRESHOLD = 0.4;
    const LOW_COMPLETION_THRESHOLD = 0.35;
    const HIGH_APPLIED_FOR_FIX = 0.4;
    const MODERATE_EFFECTIVE_THRESHOLD = 0.55;
    const MIN_APPLIED_FOR_DERIVED = 0.25;

    // High fallback rate → skill frequently selected but not used → FIX
    if (metrics.fallbackRate > FALLBACK_THRESHOLD) {
      return {
        type: 'fix',
        direction: `High fallback rate (${(metrics.fallbackRate * 100).toFixed(0)}%): skill is frequently selected but not applied, suggesting instructions are unclear or outdated.`,
      };
    }

    // Applied often but rarely completes → instructions are wrong → FIX
    if (metrics.appliedRate > HIGH_APPLIED_FOR_FIX && metrics.completionRate < LOW_COMPLETION_THRESHOLD) {
      return {
        type: 'fix',
        direction: `Low completion rate (${(metrics.completionRate * 100).toFixed(0)}%) despite high applied rate (${(metrics.appliedRate * 100).toFixed(0)}%): skill instructions may be incorrect or incomplete.`,
      };
    }

    // Moderate effectiveness → could be better → DERIVED
    if (metrics.effectiveRate < MODERATE_EFFECTIVE_THRESHOLD && metrics.appliedRate > MIN_APPLIED_FOR_DERIVED) {
      return {
        type: 'derived',
        direction: `Moderate effectiveness (${(metrics.effectiveRate * 100).toFixed(0)}%): skill works sometimes but could be enhanced with better error handling or alternative approaches.`,
      };
    }

    return { type: null, direction: '' };
  }

  /**
   * Scans all active skills and identifies those needing evolution.
   *
   * Ported from OpenSpace's SkillEvolver.process_metric_check().
   * Two-phase: rule-based candidate screening (relaxed thresholds) →
   * returns candidates for LLM confirmation by the IDE Agent.
   *
   * Anti-loop (data-driven): newly-evolved skills start with
   * totalSelections=0, requiring minSelections fresh data points
   * before being re-evaluated. No time-based cooldown needed.
   *
   * @param {object} [options]
   * @param {number} [options.minSelections=5] - Minimum selections before evaluating
   * @returns {{ candidates: Array<{ name: string, type: string, direction: string, metrics: object }> }}
   */
  processMetricCheck({ minSelections = 5 } = {}) {
    const candidates = [];

    for (const [name, meta] of this.registry) {
      if (meta.retiredAt) continue;

      const selections = meta.totalSelections || 0;
      if (selections < minSelections) continue;

      const diagnosis = this.diagnoseSkillHealth(name);
      if (diagnosis.type === null) continue;

      candidates.push({
        name,
        type: diagnosis.type,
        direction: diagnosis.direction,
        metrics: this.getHealthMetrics(name),
      });
    }

    if (candidates.length > 0) {
      console.error(`[SkillEvolution] 📊 Metric check found ${candidates.length} candidate(s) for evolution`);
    }

    return { candidates };
  }

  /**
   * Returns a comprehensive health report for all active skills.
   *
   * @returns {string} Human-readable health report
   */
  getHealthReport() {
    const lines = [
      '## 🏥 Skill Health Report',
      '',
      '| Skill | Selections | Applied% | Completion% | Effective% | Fallback% | Status |',
      '|-------|-----------|----------|-------------|------------|-----------|--------|',
    ];

    for (const [name, meta] of this.registry) {
      if (meta.retiredAt) continue;

      const metrics = this.getHealthMetrics(name);
      if (!metrics) continue;

      const diagnosis = this.diagnoseSkillHealth(name);
      const status = diagnosis.type === 'fix' ? '🔴 FIX'
        : diagnosis.type === 'derived' ? '🟡 ENHANCE'
        : metrics.totalSelections < 5 ? '⚪ NEW'
        : '🟢 HEALTHY';

      lines.push(
        `| ${name} | ${metrics.totalSelections} | ${(metrics.appliedRate * 100).toFixed(0)}% | ${(metrics.completionRate * 100).toFixed(0)}% | ${(metrics.effectiveRate * 100).toFixed(0)}% | ${(metrics.fallbackRate * 100).toFixed(0)}% | ${status} |`
      );
    }

    return lines.join('\n');
  }
}

module.exports = { SkillEvolutionEngine };
