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
const { PATHS } = require('./constants');

// ─── Skill Evolution Engine ───────────────────────────────────────────────────

class SkillEvolutionEngine {
  /**
   * @param {string} [skillsDir] - Directory containing skill markdown files
   * @param {string} [registryPath] - Path to skill registry JSON
   */
  constructor(skillsDir = null, registryPath = null) {
    this.skillsDir = skillsDir || PATHS.SKILLS_DIR;
    this.registryPath = registryPath || path.join(PATHS.OUTPUT_DIR, 'skill-registry.json');
    /** @type {Map<string, SkillMeta>} */
    this.registry = new Map();
    this._loadRegistry();
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
  registerSkill({ name, description, domains = [], type = 'domain-skill', loadLevel = 'task', dependencies = [], maxTokens = null, triggers = {} }) {
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
      filePath: path.join(this.skillsDir, `${name}.md`),
      createdAt: new Date().toISOString(),
    };
    this.registry.set(name, meta);
    this._saveRegistry();

    // Create skill file if not exists
    if (!fs.existsSync(meta.filePath)) {
      this._createSkillFile(meta);
    }
    console.log(`[SkillEvolution] Skill registered: ${name}`);
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

    // Read current skill file
    let skillContent = '';
    if (fs.existsSync(meta.filePath)) {
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
      meta.version = dedupVersion;
      meta.evolutionCount += 1;
      meta.lastEvolvedAt = new Date().toISOString();
      this._saveRegistry();
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
    meta.version = newVersion;
    meta.evolutionCount += 1;
    meta.lastEvolvedAt = new Date().toISOString();
    this._saveRegistry();

    console.log(`[SkillEvolution] ✨ Skill evolved: ${skillName} → v${meta.version} (${reason || title})`);
    return true;
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

    // Determine sections based on skill type
    let sections;
    if (meta.type === 'troubleshooting') {
      sections = [
        `## Common Errors`,
        ``,
        `_No errors documented yet. Errors will be added from complaint resolutions._`,
        ``,
        `## Root Cause Analysis`,
        ``,
        `_No root causes documented yet._`,
        ``,
        `## Fix Recipes`,
        ``,
        `_No fix recipes documented yet._`,
        ``,
        `## Prevention Rules`,
        ``,
        `_No prevention rules defined yet._`,
      ];
    } else if (meta.type === 'standards') {
      sections = [
        `## Coding Standards`,
        ``,
        `_No coding standards defined yet._`,
        ``,
        `## Naming Conventions`,
        ``,
        `_No naming conventions defined yet._`,
        ``,
        `## Directory Structure`,
        ``,
        `_No directory structure rules defined yet._`,
        ``,
        `## Commit Conventions`,
        ``,
        `_No commit conventions defined yet._`,
      ];
    } else {
      sections = [
        `## Rules`,
        ``,
        `_No rules defined yet. Rules will be added as experience accumulates._`,
        ``,
        `## SOP (Standard Operating Procedure)`,
        ``,
        `_No SOP defined yet._`,
        ``,
        `## Checklist`,
        ``,
        `_No checklist defined yet._`,
        ``,
        `## Best Practices`,
        ``,
        `_No best practices defined yet._`,
        ``,
        `## Anti-Patterns`,
        ``,
        `_No anti-patterns defined yet._`,
        ``,
        `## Context Hints`,
        ``,
        `_No context hints defined yet._`,
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
    ].join('\n');

    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
    }
    // N48 fix: atomic write – write to .tmp first, then rename over the target.
    const tmpPath = meta.filePath + '.tmp';
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, meta.filePath);
    console.log(`[SkillEvolution] Skill file created: ${meta.filePath}`);
  }

  /**
   * Parses YAML frontmatter from a skill file content.
   * Returns an object with the parsed metadata, or null if no frontmatter found.
   *
   * @param {string} content - Skill file content
   * @returns {{ meta: object, bodyStart: number }|null}
   */
  _parseFrontmatter(content) {
    if (!content || !content.startsWith('---')) return null;
    const endIdx = content.indexOf('---', 3);
    if (endIdx === -1) return null;

    const yamlBlock = content.slice(3, endIdx).trim();
    const meta = {};
    let currentKey = null;

    for (const line of yamlBlock.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Handle nested keys (e.g. "  keywords: [...]")
      if (line.startsWith('  ') && currentKey) {
        const nestedMatch = trimmed.match(/^(\w+):\s*(.*)$/);
        if (nestedMatch) {
          if (typeof meta[currentKey] !== 'object' || Array.isArray(meta[currentKey])) {
            meta[currentKey] = {};
          }
          meta[currentKey][nestedMatch[1]] = this._parseYamlValue(nestedMatch[2]);
        }
        continue;
      }

      // Handle top-level keys
      const match = trimmed.match(/^(\w+):\s*(.*)$/);
      if (match) {
        currentKey = match[1];
        const val = match[2];
        // Check if next lines are nested (triggers:)
        if (val === '' || val === undefined) {
          meta[currentKey] = {};
        } else {
          meta[currentKey] = this._parseYamlValue(val);
        }
      }
    }

    return { meta, bodyStart: endIdx + 3 };
  }

  /**
   * Parses a simple YAML value (string, number, array).
   * @param {string} val
   * @returns {*}
   */
  _parseYamlValue(val) {
    if (!val || val.trim() === '') return '';
    const trimmed = val.trim();
    // Array: [item1, item2]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const inner = trimmed.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    // Quoted string
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }
    // Number
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    return trimmed;
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
}

module.exports = { SkillEvolutionEngine };
