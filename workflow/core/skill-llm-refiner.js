/**
 * Skill LLM Refiner – LLM-Lite Skill Refinement Module
 *
 * Implements the "LLM-Lite" pattern inspired by OpenSpace's SkillEvolver,
 * but with 1% of the token cost:
 *
 *   OpenSpace: 5-round Agent Loop + tool access + retry = 6K-32K tokens/evolution
 *   LLM-Lite:  Single LLM call + rule-based fallback = 2K-3K tokens/refinement
 *
 * Three scenarios:
 *   A. refineSkill()          – Consolidate bloated skills (evolutionCount > threshold)
 *   B. fixSkill()             – Repair underperforming skills (before retirement)
 *   C. generateSkillContent() – Generate high-quality initial content for auto-created skills
 *
 * Design principles:
 *   - Single LLM call per scenario (no Agent Loop, no retries)
 *   - Graceful fallback: if LLM fails, return null (caller uses rule-based path)
 *   - Non-blocking: refinement is async, never blocks the main workflow
 *   - Token-efficient: prompts are compact, outputs are bounded
 *   - ADR-37 compliant: LLM is used as enhancement, not dependency
 *   - Cost-aware: prefers cheapLlmCall (GPT-4o-mini / Gemini Flash tier) over
 *     the main workflow model. ~$0.002/call vs ~$0.10/call = 50x cheaper.
 *
 * @module skill-llm-refiner
 */

'use strict';

const { introspectionCollector } = require('./workflow-introspection-collector');
const { prepareGatewayPrompt } = require('./llm-injection-gateway');

// ─── Configuration ──────────────────────────────────────────────────────────

const REFINER_CONFIG = {
  // Scenario A: Refinement triggers
  REFINE_EVOLUTION_COUNT_THRESHOLD: 5,  // Refine after N evolutions
  REFINE_FILE_SIZE_THRESHOLD: 2048,     // Refine when skill file > 2KB

  // Scenario B: Fix triggers
  FIX_HIT_RATE_THRESHOLD: 0.20,        // Fix when hitRate < 20%
  FIX_MIN_USAGE_COUNT: 10,             // Minimum usage before judging

  // Token limits
  MAX_SKILL_CONTENT_CHARS: 8000,       // Truncate skill content in prompt
  MAX_OUTPUT_CHARS: 6000,              // Max expected output length

  // Cooldown: prevent repeated refinement of the same skill
  REFINE_COOLDOWN_MS: 7 * 24 * 60 * 60 * 1000, // 7 days

  // P1-A: Apply-Retry (OpenSpace-inspired)
  // When refinement output fails validation, feed error + current content
  // back to LLM for retry. Max 3 attempts total.
  MAX_RETRY_ATTEMPTS: 3,
};

// ─── Skill LLM Refiner ─────────────────────────────────────────────────────

class SkillLlmRefiner {
  /**
   * @param {object} options
   * @param {Function} options.llmCall          – Async function: (prompt: string) => string (main model)
   * @param {Function} [options.cheapLlmCall]   – Async function: (prompt: string) => string (cheap model, e.g. GPT-4o-mini)
   *   When provided, all refine/fix/generate calls use cheapLlmCall instead of llmCall.
   *   This enables ~50x cost reduction for skill maintenance tasks.
   * @param {object}   [options.config]          – Override REFINER_CONFIG values
   */
  constructor(options = {}) {
    const cheapFn = typeof options.cheapLlmCall === 'function' ? options.cheapLlmCall : null;
    const mainFn  = typeof options.llmCall === 'function' ? options.llmCall : null;
    if (!cheapFn && !mainFn) {
      throw new Error('[SkillLlmRefiner] At least one of llmCall or cheapLlmCall must be a function');
    }
    // Prefer cheap model for all skill maintenance tasks (ADR-37 cost-aware)
    this._llmCall = cheapFn || mainFn;
    this._usingCheapModel = !!cheapFn;
    this._config = { ...REFINER_CONFIG, ...options.config };

    /** @type {Map<string, number>} skillName → last refinement timestamp */
    this._refineCooldowns = new Map();

    /** @type {{ refined: number, fixed: number, generated: number, failed: number }} */
    this._stats = { refined: 0, fixed: 0, generated: 0, failed: 0 };

    if (this._usingCheapModel) {
      console.log(`[SkillLlmRefiner] 💰 Using cheap LLM model for skill maintenance (50x cost reduction)`);
    }
  }

  // ─── Scenario A: Refine Bloated Skill ─────────────────────────────────────

  /**
   * Checks if a skill needs refinement based on evolution count and file size.
   *
   * @param {object} skillMeta – Skill metadata from registry
   * @param {string} skillContent – Current skill file content
   * @returns {boolean}
   */
  shouldRefine(skillMeta, skillContent) {
    if (!skillMeta || !skillContent) return false;

    // Check cooldown
    const lastRefine = this._refineCooldowns.get(skillMeta.name);
    if (lastRefine && (Date.now() - lastRefine) < this._config.REFINE_COOLDOWN_MS) {
      return false;
    }

    const evolutionCount = skillMeta.evolutionCount || 0;
    const fileSize = skillContent.length;

    return (
      evolutionCount >= this._config.REFINE_EVOLUTION_COUNT_THRESHOLD &&
      fileSize >= this._config.REFINE_FILE_SIZE_THRESHOLD
    );
  }

  /**
   * Refines a bloated skill by consolidating duplicate entries, removing
   * outdated advice, and improving structure.
   *
   * Single LLM call. Returns null on failure (caller keeps original content).
   *
   * @param {object} skillMeta – Skill metadata from registry
   * @param {string} skillContent – Current skill file content
   * @returns {Promise<string|null>} Refined content, or null on failure
   */
  async refineSkill(skillMeta, skillContent) {
    if (!this.shouldRefine(skillMeta, skillContent)) return null;

    const _gatewayCallSite = 'workflow/core/skill-llm-refiner.js:refineSkill';
    const truncatedContent = skillContent.slice(0, this._config.MAX_SKILL_CONTENT_CHARS);
    const truncated = skillContent.length > this._config.MAX_SKILL_CONTENT_CHARS;

    const prompt = [
      `You are a skill document editor. Refine the following skill file that has accumulated ${skillMeta.evolutionCount} evolutions.`,
      ``,
      `## Instructions`,
      `1. Merge duplicate or near-duplicate entries within each section`,
      `2. Remove outdated or contradictory advice (keep the newer version)`,
      `3. Improve readability and structure`,
      `4. Preserve ALL valuable information — do not delete unique insights`,
      `5. Keep the YAML frontmatter unchanged`,
      `6. Keep the Evolution History section unchanged`,
      `7. Output the COMPLETE refined skill file in Markdown format`,
      ``,
      `## Current Skill Content${truncated ? ' (truncated)' : ''}`,
      `\`\`\`markdown`,
      truncatedContent,
      `\`\`\``,
      ``,
      `## Output`,
      `Return ONLY the refined Markdown content. No explanations.`,
    ].join('\n');

    // P1-A: Apply-Retry loop (OpenSpace-inspired)
    // When validation fails, feed error + current content back to LLM.
    const maxAttempts = this._config.MAX_RETRY_ATTEMPTS || 3;
    let lastError = null;
    let currentPrompt = prompt;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this._llmCall(prepareGatewayPrompt(this, {
          callSite: _gatewayCallSite,
          role: 'skill-llm-refiner',
          stage: 'EVOLVE',
          runtimePrompt: currentPrompt,
          metadata: { category: 'llm-lite-call', attempt },
        }));
        if (!result || typeof result !== 'string') {
          lastError = 'LLM returned empty result';
          continue;
        }

        // Extract markdown content (strip code fences if present)
        let refined = result.trim();
        if (refined.startsWith('```markdown')) {
          refined = refined.slice('```markdown'.length);
        } else if (refined.startsWith('```')) {
          refined = refined.slice(3);
        }
        if (refined.endsWith('```')) {
          refined = refined.slice(0, -3);
        }
        refined = refined.trim();

        // Validation checks (with retry on failure)
        if (refined.length < 100) {
          lastError = `Output too short (${refined.length} chars)`;
          console.warn(`[SkillLlmRefiner] Attempt ${attempt}/${maxAttempts}: ${lastError}`);
          currentPrompt = this._buildRetryPrompt(prompt, lastError, skillContent);
          continue;
        }

        if (skillContent.startsWith('---') && !refined.startsWith('---')) {
          lastError = 'Output lost YAML frontmatter';
          console.warn(`[SkillLlmRefiner] Attempt ${attempt}/${maxAttempts}: ${lastError}`);
          currentPrompt = this._buildRetryPrompt(prompt, lastError, skillContent);
          continue;
        }

        // Success!
        this._refineCooldowns.set(skillMeta.name, Date.now());
        this._stats.refined++;

        if (attempt > 1) {
          console.error(`[SkillLlmRefiner] ✅ Apply-retry succeeded on attempt ${attempt}/${maxAttempts}`);
        }

        console.log(`[SkillLlmRefiner] ✨ Refined skill "${skillMeta.name}": ${skillContent.length} → ${refined.length} chars (${((1 - refined.length / skillContent.length) * 100).toFixed(0)}% reduction)`);

        introspectionCollector.recordSkill('llm-refined', {
          skillName: skillMeta.name,
          originalSize: skillContent.length,
          refinedSize: refined.length,
          evolutionCount: skillMeta.evolutionCount,
          retryAttempts: attempt - 1,
        });

        return refined;
      } catch (err) {
        lastError = err.message;
        console.warn(`[SkillLlmRefiner] Attempt ${attempt}/${maxAttempts} failed for "${skillMeta.name}": ${err.message}`);
        if (attempt < maxAttempts) {
          currentPrompt = this._buildRetryPrompt(prompt, lastError, skillContent);
        }
      }
    }

    // All attempts exhausted
    console.warn(`[SkillLlmRefiner] Apply-retry exhausted after ${maxAttempts} attempts for "${skillMeta.name}". Last error: ${lastError}`);
    this._stats.failed++;
    return null;
  }

  /**
   * P1-A: Builds a retry prompt that includes the error and current disk content.
   * Ported from OpenSpace's _apply_with_retry() pattern.
   *
   * @param {string} originalPrompt - The original refinement prompt
   * @param {string} error - The validation error from the previous attempt
   * @param {string} currentContent - Current skill content on disk (ground truth)
   * @returns {string} Retry prompt
   */
  _buildRetryPrompt(originalPrompt, error, currentContent) {
    const truncatedCurrent = currentContent.slice(0, this._config.MAX_SKILL_CONTENT_CHARS);
    return [
      originalPrompt,
      ``,
      `## ⚠️ RETRY — Previous attempt failed`,
      `Error: ${error}`,
      ``,
      `## Current content on disk (ground truth — use this, not your memory)`,
      `\`\`\`markdown`,
      truncatedCurrent,
      `\`\`\``,
      ``,
      `Please fix the issue and generate the refined content again.`,
      `Follow the same output format as before.`,
    ].join('\n');
  }

  // ─── Scenario B: Fix Underperforming Skill ────────────────────────────────

  /**
   * Checks if a skill should be fixed (before retirement).
   *
   * @param {object} skillMeta – Skill metadata from registry
   * @returns {boolean}
   */
  shouldFix(skillMeta) {
    if (!skillMeta) return false;
    if (skillMeta.retiredAt) return false;

    const usage = skillMeta.usageCount || 0;
    const effective = skillMeta.effectiveCount || 0;

    if (usage < this._config.FIX_MIN_USAGE_COUNT) return false;

    const hitRate = effective / usage;
    return hitRate < this._config.FIX_HIT_RATE_THRESHOLD;
  }

  /**
   * Attempts to fix an underperforming skill by analysing its content
   * and usage patterns.
   *
   * Returns:
   *   - { action: 'fix', content: string } – Fixed content to write
   *   - { action: 'retire' } – LLM recommends retirement
   *   - null – LLM call failed (caller decides)
   *
   * @param {object} skillMeta – Skill metadata from registry
   * @param {string} skillContent – Current skill file content
   * @returns {Promise<{ action: 'fix'|'retire', content?: string }|null>}
   */
  async fixSkill(skillMeta, skillContent) {
    if (!this.shouldFix(skillMeta)) return null;

    const _gatewayCallSite = 'workflow/core/skill-llm-refiner.js:fixSkill';
    const usage = skillMeta.usageCount || 0;
    const effective = skillMeta.effectiveCount || 0;
    const hitRate = ((effective / usage) * 100).toFixed(1);
    const truncatedContent = skillContent.slice(0, this._config.MAX_SKILL_CONTENT_CHARS);

    const prompt = [
      `You are a skill quality analyst. This skill has poor effectiveness and may need fixing or retirement.`,
      ``,
      `## Skill Metrics`,
      `- Name: ${skillMeta.name}`,
      `- Usage count: ${usage} (times injected into prompts)`,
      `- Effective count: ${effective} (times the stage passed after injection)`,
      `- Hit rate: ${hitRate}%`,
      `- Domains: ${(skillMeta.domains || []).join(', ')}`,
      `- Keywords: ${(skillMeta.triggers?.keywords || []).join(', ')}`,
      `- Last used: ${skillMeta.lastUsedAt || 'never'}`,
      `- Last effective: ${skillMeta.lastEffectiveAt || 'never'}`,
      ``,
      `## Current Content`,
      `\`\`\`markdown`,
      truncatedContent,
      `\`\`\``,
      ``,
      `## Analysis Required`,
      `1. Is the skill content outdated or incorrect?`,
      `2. Are the trigger keywords too broad (matching irrelevant tasks)?`,
      `3. Is the advice too generic to be actionable?`,
      ``,
      `## Output Format`,
      `If the skill can be fixed, output:`,
      `ACTION: FIX`,
      `Then the complete fixed Markdown content.`,
      ``,
      `If the skill should be retired (content is fundamentally wrong or irrelevant), output:`,
      `ACTION: RETIRE`,
      `REASON: <one-line explanation>`,
    ].join('\n');

    // P1-A: Apply-Retry loop (OpenSpace-inspired)
    const maxAttempts = this._config.MAX_RETRY_ATTEMPTS || 3;
    let lastError = null;
    let currentPrompt = prompt;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this._llmCall(prepareGatewayPrompt(this, {
          callSite: _gatewayCallSite,
          role: 'skill-llm-refiner',
          stage: 'EVOLVE',
          runtimePrompt: currentPrompt,
          metadata: { category: 'llm-lite-call', attempt },
        }));
        if (!result || typeof result !== 'string') {
          lastError = 'LLM returned empty result';
          continue;
        }

        const trimmed = result.trim();

        if (trimmed.startsWith('ACTION: RETIRE') || trimmed.includes('\nACTION: RETIRE')) {
          this._stats.fixed++;
          console.log(`[SkillLlmRefiner] 📦 LLM recommends retiring skill "${skillMeta.name}"`);
          return { action: 'retire' };
        }

        if (trimmed.startsWith('ACTION: FIX') || trimmed.includes('\nACTION: FIX')) {
          const fixIdx = trimmed.indexOf('ACTION: FIX');
          let content = trimmed.slice(fixIdx + 'ACTION: FIX'.length).trim();

          if (content.startsWith('```markdown')) {
            content = content.slice('```markdown'.length);
          } else if (content.startsWith('```')) {
            content = content.slice(3);
          }
          if (content.endsWith('```')) {
            content = content.slice(0, -3);
          }
          content = content.trim();

          if (content.length < 100) {
            lastError = `Fix output too short (${content.length} chars)`;
            console.warn(`[SkillLlmRefiner] Attempt ${attempt}/${maxAttempts}: ${lastError}`);
            currentPrompt = this._buildRetryPrompt(prompt, lastError, skillContent);
            continue;
          }

          this._stats.fixed++;
          if (attempt > 1) {
            console.error(`[SkillLlmRefiner] ✅ Fix apply-retry succeeded on attempt ${attempt}/${maxAttempts}`);
          }
          console.log(`[SkillLlmRefiner] 🔧 Fixed skill "${skillMeta.name}" (hitRate ${hitRate}% → content updated)`);

          introspectionCollector.recordSkill('llm-fixed', {
            skillName: skillMeta.name,
            hitRate: parseFloat(hitRate),
            usageCount: usage,
            effectiveCount: effective,
            retryAttempts: attempt - 1,
          });

          return { action: 'fix', content };
        }

        // Unrecognised output format — retry with guidance
        lastError = 'Unrecognised output format (expected ACTION: FIX or ACTION: RETIRE)';
        console.warn(`[SkillLlmRefiner] Attempt ${attempt}/${maxAttempts}: ${lastError}`);
        currentPrompt = this._buildRetryPrompt(prompt, lastError, skillContent);
      } catch (err) {
        lastError = err.message;
        console.warn(`[SkillLlmRefiner] Fix attempt ${attempt}/${maxAttempts} failed for "${skillMeta.name}": ${err.message}`);
        if (attempt < maxAttempts) {
          currentPrompt = this._buildRetryPrompt(prompt, lastError, skillContent);
        }
      }
    }

    console.warn(`[SkillLlmRefiner] Fix apply-retry exhausted after ${maxAttempts} attempts for "${skillMeta.name}". Last error: ${lastError}`);
    this._stats.failed++;
    return null;
  }

  // ─── Scenario C: Generate Initial Skill Content ───────────────────────────

  /**
   * Generates high-quality initial content for an auto-created skill.
   * Used when P1 Auto-Create creates a new skill from an orphan experience.
   *
   * Returns the generated Markdown body (sections only, no frontmatter),
   * or null on failure (caller uses the default template).
   *
   * @param {object} options
   * @param {string}   options.skillName    – Inferred skill name
   * @param {string}   options.description  – Skill description
   * @param {string[]} options.domains      – Skill domains
   * @param {object}   options.sourceExp    – Source experience that triggered creation
   * @returns {Promise<string|null>} Generated section content, or null
   */
  async generateSkillContent({ skillName, description, domains, sourceExp }) {
    if (!sourceExp) return null;

    const prompt = [
      `You are a skill document generator. Create high-quality initial content for a new skill file.`,
      ``,
      `## Skill Metadata`,
      `- Name: ${skillName}`,
      `- Description: ${description}`,
      `- Domains: ${(domains || []).join(', ')}`,
      ``,
      `## Source Experience (the pattern that triggered this skill creation)`,
      `- Title: ${sourceExp.title}`,
      `- Category: ${sourceExp.category}`,
      `- Content: ${(sourceExp.content || '').slice(0, 2000)}`,
      `- Tags: ${(sourceExp.tags || []).join(', ')}`,
      sourceExp.codeExample ? `- Code Example:\n\`\`\`\n${sourceExp.codeExample.slice(0, 1000)}\n\`\`\`` : '',
      ``,
      `## Instructions`,
      `Generate content for these sections (Markdown format):`,
      `1. ## Rules — 2-3 prescriptive rules based on the experience`,
      `2. ## Best Practices — 2-3 recommended patterns`,
      `3. ## Anti-Patterns — 1-2 common mistakes to avoid`,
      `4. ## Checklist — 3-5 verification items`,
      ``,
      `Keep each section concise (3-5 bullet points max).`,
      `Do NOT include frontmatter, skill title, or Evolution History.`,
      `Output ONLY the section content in Markdown.`,
    ].join('\n');

    try {
      const result = await this._llmCall(prepareGatewayPrompt(this, {
        callSite: 'workflow/core/skill-llm-refiner.js:generateSkillContent',
        role: 'skill-llm-refiner',
        stage: 'EVOLVE',
        runtimePrompt: prompt,
        metadata: { category: 'llm-lite-call', skillName },
      }));
      if (!result || typeof result !== 'string' || result.trim().length < 50) {
        this._stats.failed++;
        return null;
      }

      this._stats.generated++;
      console.log(`[SkillLlmRefiner] 🎯 Generated initial content for skill "${skillName}" (${result.trim().length} chars)`);

      introspectionCollector.recordSkill('llm-generated', {
        skillName,
        sourceExpId: sourceExp.id,
        contentLength: result.trim().length,
      });

      return result.trim();
    } catch (err) {
      console.warn(`[SkillLlmRefiner] Content generation failed for "${skillName}": ${err.message}`);
      this._stats.failed++;
      return null;
    }
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  /**
   * Returns refinement statistics.
   * @returns {{ refined: number, fixed: number, generated: number, failed: number }}
   */
  getStats() {
    return { ...this._stats };
  }

  /**
   * Resets cooldown for a specific skill (for testing).
   * @param {string} skillName
   */
  resetCooldown(skillName) {
    this._refineCooldowns.delete(skillName);
  }
}

module.exports = { SkillLlmRefiner, REFINER_CONFIG };
