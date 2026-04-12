/**
 * ContextLoader Skill Loading Utilities
 *
 * Extracted from context-loader.js for maintainability (ADR-41).
 * Contains skill loading, validation, and lazy enrichment logic.
 *
 * @module workflow/core/context-loader-skills
 */

'use strict';

const path = require('path');
const { estimateTokens } = require('../tools/thin-tools');
const { MAX_DEP_DEPTH, MAX_DEP_SKILL_TOKENS } = require('./context-loader-config');

// ─── Progressive Loading Configuration ───────────────────────────────────────

/**
 * Progressive Disclosure Configuration (Claude Code Skill pattern)
 *
 * Skills can define a "description" section that is ALWAYS loaded (for matching),
 * while the detailed "content" is only loaded when the task keywords indicate
 * specific need.
 *
 * This reduces token usage for matched skills that aren't immediately relevant
to the current task.
 *
 * Skill format:
 *   ---
 *   name: skill-name
 *   triggers:
 *     keywords: [foo, bar]
 *   ---
 *
 *   ## Description（常驻）
 *   Short summary visible for all tasks.
 *
 *   <!-- PROGRESSIVE_LOAD_TRIGGER: foo|bar -->
 *
 *   ## Content（按需）
 *   Detailed content loaded only when foo|bar keywords present in task.
 */
const PROGRESSIVE_CONFIG = {
  // Marker that separates description from content
  PROGRESSIVE_TRIGGER_MARKER: /<!--\s*PROGRESSIVE_LOAD_TRIGGER:\s*([^>]+)\s*-->/i,
  // Default behavior: load full content or just description
  DEFAULT_LOAD_FULL: true,
  // Max tokens for description-only mode (much smaller than full skill)
  MAX_DESCRIPTION_TOKENS: 150,
  // Token budget threshold: below this, only load descriptions
  PROGRESSIVE_MODE_THRESHOLD: 2000,
};

// Track task keywords for progressive loading
let _currentTaskKeywords = [];

/**
 * Sets current task keywords for progressive skill loading.
 * Called by ContextLoader before loading skills.
 *
 * @param {string[]} keywords - Array of keywords/phrases from task text
 */
function setProgressiveLoadContext(keywords) {
  _currentTaskKeywords = keywords || [];
}

/**
 * Checks if progressive mode should be used based on available tokens
 * @param {number} availableTokens
 * @returns {boolean}
 */
function shouldUseProgressiveMode(availableTokens) {
  return availableTokens < PROGRESSIVE_CONFIG.PROGRESSIVE_MODE_THRESHOLD;
}

/**
 * Parses a skill file to extract description-only or full content
 * based on progressive loading rules.
 *
 * @param {string} content - Full skill file content
 * @param {string[]} taskKeywords - Keywords from current task (if empty, load full)
 * @param {object} meta - Parsed frontmatter metadata
 * @returns {{ content: string, isProgressive: boolean, matchedTriggers: string[] }}
 */
function parseProgressiveSkill(content, taskKeywords, meta) {
  // Check if skill has progressive trigger marker
  const markerMatch = content.match(PROGRESSIVE_CONFIG.PROGRESSIVE_TRIGGER_MARKER);

  if (!markerMatch) {
    // No progressive marker - return full content
    return { content, isProgressive: false, matchedTriggers: [] };
  }

  // Extract triggers from marker
  const triggerStr = markerMatch[1];
  const triggers = triggerStr.split('|').map(t => t.trim().toLowerCase());

  // Check if any task keyword matches any trigger
  const matchedTriggers = [];
  if (taskKeywords.length > 0) {
    for (const keyword of taskKeywords) {
      const keywordLower = keyword.toLowerCase();
      for (const trigger of triggers) {
        if (keywordLower.includes(trigger) || trigger.includes(keywordLower)) {
          matchedTriggers.push(trigger);
        }
      }
    }
  }

  // Always load full content if:
  // 1. No progressive threshold (not in tight token budget)
  // 2. Keyword match found
  // 3. Triggers include '@always' wildcard
  if (!shouldUseProgressiveMode(PROGRESSIVE_CONFIG.PROGRESSIVE_MODE_THRESHOLD) ||
      matchedTriggers.length > 0 ||
      triggers.includes('@always')) {
    return { content, isProgressive: false, matchedTriggers: [...new Set(matchedTriggers)] };
  }

  // Progressive mode: extract only the description section
  const markerIndex = content.indexOf(markerMatch[0]);
  const descriptionContent = content.slice(0, markerIndex).trim();

  return {
    content: descriptionContent,
    isProgressive: true,
    matchedTriggers: [],
  };
}

// ─── Skill Loading ───────────────────────────────────────────────────────────

/**
 * Loads a skill with its dependencies recursively.
 *
 * @param {object} options
 * @param {string} options.skillName - Name of the skill to load
 * @param {number} options.tokenBudget - Token budget for this skill
 * @param {number} [options.depth=0] - Current recursion depth
 * @param {Set<string>} [options.visited] - Set of already visited skills (circular dep guard)
 * @param {Set<string>} options.loadedSkillsInResolve - Set of skills already loaded in this resolve
 * @param {Function} options.loadSkill - Function to load a single skill
 * @param {string} options.skillsDir - Skills directory path
 * @returns {{ sections: string[], sources: string[], tokens: number }|null}
 */
function loadSkillWithDeps({
  skillName,
  tokenBudget,
  depth = 0,
  visited = null,
  loadedSkillsInResolve,
  loadSkill,
  skillsDir,
}) {
  if (!visited) visited = new Set();

  // Circular dependency guard
  if (visited.has(skillName)) {
    console.log(`[ContextLoader] ⚠️ Circular dependency detected: ${skillName} – skipping`);
    return null;
  }
  visited.add(skillName);

  const result = { sections: [], sources: [], tokens: 0 };

  // Load the skill itself
  const loaded = loadSkill(skillName, tokenBudget, depth > 0);
  if (!loaded) return null;

  result.sections.push(loaded.section);
  result.sources.push(loaded.source);
  result.tokens += loaded.tokens;
  loadedSkillsInResolve.add(skillName);

  // Resolve dependencies if within depth limit
  if (depth < MAX_DEP_DEPTH && loaded.dependencies && loaded.dependencies.length > 0) {
    let depBudget = tokenBudget - loaded.tokens;
    for (const depName of loaded.dependencies) {
      if (depBudget <= 0) break;
      if (loadedSkillsInResolve.has(depName)) continue;
      const depLoaded = loadSkillWithDeps({
        skillName: depName,
        tokenBudget: Math.min(MAX_DEP_SKILL_TOKENS, depBudget),
        depth: depth + 1,
        visited,
        loadedSkillsInResolve,
        loadSkill,
        skillsDir,
      });
      if (depLoaded) {
        result.sections.push(...depLoaded.sections);
        result.sources.push(...depLoaded.sources);
        result.tokens += depLoaded.tokens;
        depBudget -= depLoaded.tokens;
      }
    }
  }

  return result;
}

/**
 * Loads a single skill file and returns a formatted section.
 *
 * @param {object} options
 * @param {string} options.skillName - Name of the skill to load
 * @param {number} options.tokenBudget - Token budget for this skill
 * @param {boolean} [options.isDep=false] - True if loaded as a dependency
 * @param {Set<string>} options.retiredSkills - Set of retired skill names
 * @param {string} options.skillsDir - Skills directory path
 * @param {Function} options.readFileCached - Cached file reader function
 * @param {Function} options.parseFrontmatter - Frontmatter parser function
 * @param {Function} options.truncate - Content truncation function
 * @returns {{ section: string, source: string, tokens: number, dependencies: string[] }|null}
 */
function loadSkill({
  skillName,
  tokenBudget,
  isDep = false,
  retiredSkills,
  skillsDir,
  readFileCached,
  parseFrontmatter,
  truncate,
  isPlaceholderSkill,
  triggerLazyEnrichment,
  validateSkillContent,
  skillRegistry = null,  // Optional: SkillEvolutionEngine registry for custom filePath lookup
}) {
  // Gap 1 fix: double-check retired status at load time
  if (retiredSkills.has(skillName)) return null;

  // Primary path: look in the standard skillsDir
  const skillPath = path.join(skillsDir, `${skillName}.md`);
  let content = readFileCached(skillPath);

  // Fallback: if not found in skillsDir, check registry for custom filePath
  // (e.g. project-specific skills stored in <projectRoot>/.workflow/skills/)
  if (!content && skillRegistry) {
    const meta = typeof skillRegistry.get === 'function'
      ? skillRegistry.get(skillName)
      : null;
    if (meta && meta.filePath && meta.filePath !== skillPath) {
      content = readFileCached(meta.filePath);
    }
  }

  if (!content) return null;

  // ADR-45: Lazy enrichment trigger for placeholder skills
  if (isPlaceholderSkill(content)) {
    triggerLazyEnrichment(skillName);
    return null;
  }

  // Parse frontmatter for metadata
  const { meta, body } = parseFrontmatter(content);
  const dependencies = meta.dependencies || [];

  // Gap 2 fix: validate skill content structure
  const validation = validateSkillContent(content, meta);
  if (!validation.valid) {
    console.log(`[ContextLoader] ⚠️ Skipping skill "${skillName}": ${validation.reason}`);
    return null;
  }

  // ─── Progressive Loading (P2: Skill Progressive Disclosure) ─────────────
  // Apply progressive loading logic for non-dependency skills
  let skillContent = content;
  let isProgressive = false;
  let matchedTriggers = [];

  if (!isDep) {
    const progressiveResult = parseProgressiveSkill(content, _currentTaskKeywords, meta);
    skillContent = progressiveResult.content;
    isProgressive = progressiveResult.isProgressive;
    matchedTriggers = progressiveResult.matchedTriggers;
  }

  // Use frontmatter max_tokens if available, capped by tokenBudget
  // For progressive mode, use smaller description-only budget
  const effectiveBudget = isProgressive
    ? Math.min(PROGRESSIVE_CONFIG.MAX_DESCRIPTION_TOKENS, tokenBudget)
    : (meta.max_tokens
        ? Math.min(meta.max_tokens, tokenBudget)
        : tokenBudget);

  // For dependency skills or progressive mode, use only the body/fragment
  const toTruncate = isDep ? body : skillContent;
  const truncated = truncate(toTruncate, effectiveBudget);
  if (!truncated) return null;

  const tokens = estimateTokens(truncated);
  const label = isDep ? '🔗 Dep-Skill' : (isProgressive ? '📋 Skill-Summary' : '🧠 Skill');

  // Add progressive loading indicator if applicable
  const progressiveIndicator = isProgressive
    ? `\n\n> 💡 *Progressive mode: Full skill content available. Use ${matchedTriggers.length > 0 ? matchedTriggers.slice(0, 3).join(', ') : 'task keywords'} to load complete version.*`
    : '';

  // ─── L3: References Directory Support (Agent Skills Spec) ──────────────
  // If the skill has a references/ subdirectory (either next to the .md file or
  // in a <skillName>/ directory), list available reference files as a navigation
  // hint. The AI can then read_file on demand (true L3 lazy loading).
  let referencesHint = '';
  const resolvedSkillPath = skillRegistry
    ? (skillRegistry.get?.(skillName)?.filePath || skillPath)
    : skillPath;
  const refsDir = _resolveReferencesDir(resolvedSkillPath, skillName, skillsDir);
  if (refsDir) {
    try {
      const refFiles = require('fs').readdirSync(refsDir)
        .filter(f => /\.(md|txt|json|yaml|yml)$/i.test(f))
        .slice(0, 10);
      if (refFiles.length > 0) {
        referencesHint = `\n\n> 📚 **References** (${refsDir}): ${refFiles.join(', ')}\n> _Use read_file to load any reference on demand (L3 lazy loading)._`;
      }
    } catch (_) { /* references dir not readable — skip */ }
  }

  return {
    section: `## ${label}: ${skillName}\n\n${truncated}${progressiveIndicator}${referencesHint}`,
    source: `${skillName}.md${isProgressive ? ' (description-only)' : ''}`,
    tokens,
    dependencies,
    isProgressive,
    matchedTriggers,
    referencesDir: refsDir || null,
  };
}

// ─── Skill Validation ────────────────────────────────────────────────────────

/**
 * Returns true if a skill file has no real content yet (only placeholder text).
 *
 * @param {string} content - Skill file content
 * @returns {boolean}
 */
function isPlaceholderSkill(content) {
  const placeholderPhrases = [
    '_No rules defined yet',
    '_No SOP defined yet',
    '_No best practices defined yet',
    '_No errors documented yet',
    '_No root causes documented yet',
    '_No fix recipes documented yet',
    '_No prevention rules defined yet',
    '_No coding standards defined yet',
    '_No naming conventions defined yet',
    '_No directory structure rules defined yet',
    '_No commit conventions defined yet',
    '_No checklist defined yet',
    '_No anti-patterns defined yet',
    '_No context hints defined yet',
  ];
  // If ALL sections are placeholders, skip the file
  const nonPlaceholderLines = content
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('|') && !l.startsWith('---'))
    .filter(l => !placeholderPhrases.some(p => l.includes(p)));
  return nonPlaceholderLines.length < 3;
}

/**
 * Validates that a skill file has meaningful content structure.
 *
 * @param {string} content - Full skill file content
 * @param {object} meta - Parsed frontmatter metadata
 * @returns {{ valid: boolean, reason: string }}
 */
function validateSkillContent(content, meta) {
  if (!content || !content.trim()) {
    return { valid: false, reason: 'empty content' };
  }

  // Check 1: minimum word count (at least 8 words of real content)
  const bodyLines = content
    .split('\n')
    .filter(l => {
      const t = l.trim();
      return t && !t.startsWith('#') && !t.startsWith('>') && !t.startsWith('|')
        && !t.startsWith('---') && !t.startsWith('_No ');
    });
  const wordCount = bodyLines.join(' ').split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount < 8) {
    return { valid: false, reason: `insufficient content (${wordCount} words, need ≥8)` };
  }

  // Check 2: if skill has YAML frontmatter (structured skill), require at least one ## heading.
  const hasFrontmatter = meta && Object.keys(meta).length > 0;
  if (hasFrontmatter) {
    const hasSections = /^## /m.test(content);
    if (!hasSections) {
      return { valid: false, reason: 'structured skill (has frontmatter) missing ## section headings' };
    }

    // Check 3: frontmatter must have name field for structured skills
    if (!meta.name) {
      return { valid: false, reason: 'frontmatter missing required "name" field' };
    }
  }

  return { valid: true, reason: '' };
}

// ─── Content Truncation ──────────────────────────────────────────────────────

/**
 * Truncates content to fit within a token budget.
 * Truncates at paragraph boundaries when possible.
 *
 * D6 optimisation: uses a content-aware chars/token ratio instead of a fixed
 * constant. Chinese text averages ~2 chars/token (vs ~4 for English).
 *
 * @param {string} content - Content to truncate
 * @param {number} tokenBudget - Token budget
 * @returns {string}
 */
function truncateContent(content, tokenBudget) {
  if (!content) return '';
  // Estimate CJK ratio from the first 200 chars to adjust chars/token ratio.
  const sample = content.slice(0, 200);
  const cjkCount = (sample.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || []).length;
  const cjkRatio = sample.length > 0 ? cjkCount / sample.length : 0;
  const charsPerToken = cjkRatio > 0.3 ? 2 : (cjkRatio > 0.1 ? 3 : 4);
  const maxChars = tokenBudget * charsPerToken;
  if (content.length <= maxChars) return content;

  // Try to truncate at a paragraph boundary
  const truncated = content.slice(0, maxChars);
  const lastPara = truncated.lastIndexOf('\n\n');
  const result = lastPara > maxChars * 0.7 ? truncated.slice(0, lastPara) : truncated;
  return result + '\n\n> *(truncated to fit token budget)*';
}

// ─── Lazy Enrichment ─────────────────────────────────────────────────────────

/**
 * Creates a lazy enrichment trigger function.
 *
 * @param {object} options
 * @param {object} [options.orchestrator] - Orchestrator instance
 * @param {Set<string>} options.enrichmentInProgress - Set of skills being enriched
 * @param {string} options.skillsDir - Skills directory path
 * @param {Map} options.fileCache - File cache to invalidate after enrichment
 * @returns {Function}
 */
function createLazyEnrichmentTrigger({ orchestrator, enrichmentInProgress, skillsDir, fileCache }) {
  return function triggerLazyEnrichment(skillName) {
    // Prevent duplicate enrichment triggers for the same skill
    if (enrichmentInProgress.has(skillName)) {
      return;
    }

    // Require orchestrator reference for enrichment
    if (!orchestrator) {
      console.log(`[ContextLoader] ⚠️ Cannot enrich "${skillName}": no orchestrator reference`);
      return;
    }

    // Mark as in-progress
    enrichmentInProgress.add(skillName);

    // Import enrichment function lazily to avoid circular dependencies
    const { enrichSkillFromExternalKnowledge } = require('./context-budget-manager');

    // Fire-and-forget enrichment
    console.log(`[ContextLoader] 🔄 Triggering lazy enrichment for "${skillName}"...`);

    enrichSkillFromExternalKnowledge(orchestrator, skillName, { maxSearchResults: 3, maxFetchPages: 2 })
      .then(r => {
        if (r.success) {
          console.log(`[ContextLoader] ✅ Lazy enrichment completed for "${skillName}": ${r.sectionsAdded} entries from ${r.sources.length} source(s)`);
          // Invalidate file cache so next load gets fresh content
          const skillPath = path.join(skillsDir, `${skillName}.md`);
          fileCache.delete(skillPath);
        } else {
          console.log(`[ContextLoader] ⚠️ Lazy enrichment failed for "${skillName}": ${r.error || 'unknown error'}`);
        }
      })
      .catch(err => {
        console.log(`[ContextLoader] ⚠️ Lazy enrichment error for "${skillName}": ${err.message}`);
      })
      .finally(() => {
        // Always remove from in-progress set
        enrichmentInProgress.delete(skillName);
      });
  };
}

// ─── L3: References Directory Resolution ─────────────────────────────────────

/**
 * Resolves the references/ directory for a skill.
 * Checks two locations (Agent Skills Spec compatible):
 *   1. <skillsDir>/<skillName>/references/   (directory-based skill)
 *   2. <skillFile>/../references/             (co-located with .md file)
 *
 * @param {string} skillFilePath - Resolved path to the skill .md file
 * @param {string} skillName - Skill name
 * @param {string} skillsDir - Skills directory
 * @returns {string|null} Path to references directory, or null if not found
 */
function _resolveReferencesDir(skillFilePath, skillName, skillsDir) {
  const fs = require('fs');

  // Path 1: <skillsDir>/<skillName>/references/
  const dirBasedRefs = path.join(skillsDir, skillName, 'references');
  if (fs.existsSync(dirBasedRefs) && fs.statSync(dirBasedRefs).isDirectory()) {
    return dirBasedRefs;
  }

  // Path 2: co-located with the skill file
  if (skillFilePath) {
    const colocatedRefs = path.join(path.dirname(skillFilePath), 'references');
    if (fs.existsSync(colocatedRefs) && fs.statSync(colocatedRefs).isDirectory()) {
      return colocatedRefs;
    }
  }

  return null;
}

module.exports = {
  loadSkillWithDeps,
  loadSkill,
  isPlaceholderSkill,
  validateSkillContent,
  truncateContent,
  createLazyEnrichmentTrigger,
  // Progressive loading (P2)
  setProgressiveLoadContext,
  shouldUseProgressiveMode,
  parseProgressiveSkill,
  // L3 references (Agent Skills Spec)
  _resolveReferencesDir,
};
