/**
 * DevTools Commands - Skill Enrichment (skill-enrich, skill-enrich-all)
 *
 * Split from commands-devtools.js for maintainability (ADR-33 Phase 3).
 *
 * @module workflow/commands/commands-devtools-skills
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS, getDefaultOutputDir } = require('../core/constants');

/**
 * Registers skills devtools commands.
 * @param {Function} registerCommand - The registerCommand function from command-router.js
 */
function registerSkillsCommands(registerCommand) {
registerCommand(
  'skill-enrich',
  'Enrich a skill with external knowledge (web search → LLM analysis → native skill content). Usage: /skill-enrich <skill-name> [--dry-run]',
  async (args, context) => {
    if (!args || !args.trim()) {
      // List skills that are candidates for enrichment (placeholder/empty)
      const { SkillEvolutionEngine } = require('../core/skill-evolution');
      const skillsDir = PATHS.SKILLS_DIR;
      const registryPath = path.join(context.orchestrator?._outputDir || getDefaultOutputDir(), 'skill-registry.json');

      let engine;
      if (context.orchestrator && context.orchestrator.services && context.orchestrator.services.has('skillEvolution')) {
        engine = context.orchestrator.services.resolve('skillEvolution');
      } else {
        engine = new SkillEvolutionEngine(skillsDir, registryPath);
      }

      const skills = engine.listSkills();
      const candidates = [];
      for (const s of skills) {
        if (s.retiredAt) continue;
        if (fs.existsSync(s.filePath)) {
          const content = fs.readFileSync(s.filePath, 'utf-8');
          const lines = content.split('\n');
          const bodyLines = lines.filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('|') && !l.startsWith('---') && !l.includes('_No '));
          const bodyWords = bodyLines.join(' ').split(/\s+/).filter(w => w.length > 0).length;

          // ADR-30 P2: Multi-dimensional hollow skill detection
          // Instead of relying solely on word count, use section fill-rate as primary indicator.
          // A skill file has expected sections: Rules, Anti-Patterns, Gotchas, Best Practices, Context Hints.
          const expectedSections = ['Rules', 'Anti-Patterns', 'Gotchas', 'Best Practices', 'Context Hints'];
          let filledSections = 0;
          for (const sec of expectedSections) {
            const secRegex = new RegExp(`^##\\s+.*${sec.replace(/-/g, '[- ]')}`, 'im');
            const secMatch = content.match(secRegex);
            if (secMatch) {
              // Check if the section has actual content (not just a header + placeholder)
              const secIdx = content.indexOf(secMatch[0]);
              const afterHeader = content.slice(secIdx + secMatch[0].length, secIdx + secMatch[0].length + 200);
              const sectionContent = afterHeader.split(/^##\s/m)[0].trim();
              const sectionWords = sectionContent.split(/\s+/).filter(w => w.length > 1 && !w.startsWith('_No')).length;
              if (sectionWords >= 10) filledSections++;
            }
          }
          const fillRate = filledSections / expectedSections.length;

          // Candidate if: low word count OR low section fill-rate
          const isHollow = bodyWords < 30 || fillRate < 0.4;
          if (isHollow) {
            candidates.push({
              name: s.name,
              words: bodyWords,
              fillRate: Math.round(fillRate * 100),
              filledSections,
              domains: (s.domains || []).join(', '),
            });
          }
        }
      }

      const lines = [
        `## 🌐 Skill Enrichment`,
        ``,
        `Usage: \`/skill-enrich <skill-name>\` — Enriches a skill with external knowledge`,
        `       \`/skill-enrich <skill-name> --dry-run\` — Preview without writing`,
        ``,
      ];

      if (candidates.length > 0) {
        lines.push(`### Enrichment Candidates (${candidates.length} skills with thin content):`);
        lines.push(`| Skill | Words | Fill Rate | Sections | Domains |`);
        lines.push(`|-------|-------|-----------|----------|---------|`);
        for (const c of candidates.sort((a, b) => a.fillRate - b.fillRate || a.words - b.words)) {
          lines.push(`| ${c.name} | ${c.words} | ${c.fillRate}% | ${c.filledSections}/5 | ${c.domains || 'general'} |`);
        }
      } else {
        lines.push(`✅ All skills have substantial content. No enrichment candidates found.`);
      }
      return lines.join('\n');
    }

    // Parse arguments
    const parts = args.trim().split(/\s+/);
    const skillName = parts[0];
    const dryRun = parts.includes('--dry-run');

    if (!context.orchestrator) {
      return `❌ No orchestrator in context. Cannot perform enrichment (needs WebSearch + LLM).`;
    }

    const { enrichSkillFromExternalKnowledge } = require('../core/context-budget-manager');

    const result = await enrichSkillFromExternalKnowledge(context.orchestrator, skillName, { dryRun });

    if (!result.success) {
      return `❌ Enrichment failed for "${skillName}": ${result.error}`;
    }

    const lines = [
      `## 🌐 Skill Enrichment ${dryRun ? '(Dry Run)' : 'Complete'}`,
      ``,
      `**Skill**: ${skillName}`,
      `**Entries added**: ${result.sectionsAdded}`,
      `**Sources**: ${(result.sources || []).length} web page(s)`,
      ``,
    ];

    if (result.sources && result.sources.length > 0) {
      lines.push(`### Sources:`);
      for (const src of result.sources) {
        lines.push(`- ${src}`);
      }
    }

    if (dryRun) {
      lines.push(``, `> 💡 This was a dry run. Run \`/skill-enrich ${skillName}\` (without --dry-run) to apply.`);
    } else {
      lines.push(``, `> ✅ Knowledge has been persisted to \`skills/${skillName}.md\`. Capsule Inheritance prevents duplicates.`);
    }

    return lines.join('\n');
  }
);

// ── Batch Skill Enrichment ───────────────────────────────────────────────────

registerCommand(
  'skill-enrich-all',
  'Batch-enrich ALL skills (or optionally only hollow/thin ones). Usage: /skill-enrich-all [--hollow-only] [--dry-run] [--concurrency=N]',
  async (args, context) => {
    if (!context.orchestrator) {
      return `❌ No orchestrator in context. Cannot perform enrichment (needs WebSearch + LLM).`;
    }

    const flags = (args || '').trim().split(/\s+/);
    const hollowOnly = flags.includes('--hollow-only');
    const dryRun = flags.includes('--dry-run');
    const concurrencyFlag = flags.find(f => f.startsWith('--concurrency='));
    const concurrency = concurrencyFlag ? parseInt(concurrencyFlag.split('=')[1], 10) || 2 : 2;

    // Get skill list via SkillEvolutionEngine
    const { SkillEvolutionEngine } = require('../core/skill-evolution');
    const skillsDir = PATHS.SKILLS_DIR;
    const registryPath = path.join(context.orchestrator?._outputDir || getDefaultOutputDir(), 'skill-registry.json');

    let engine;
    if (context.orchestrator.services && context.orchestrator.services.has('skillEvolution')) {
      engine = context.orchestrator.services.resolve('skillEvolution');
    } else {
      engine = new SkillEvolutionEngine(skillsDir, registryPath);
    }

    const allSkills = engine.listSkills().filter(s => !s.retiredAt);

    // Filter to hollow skills if requested
    let targetSkills = allSkills;
    if (hollowOnly) {
      targetSkills = allSkills.filter(s => {
        if (!fs.existsSync(s.filePath)) return false;
        const content = fs.readFileSync(s.filePath, 'utf-8');
        const expectedSections = ['Rules', 'Anti-Patterns', 'Gotchas', 'Best Practices', 'Context Hints', 'SOP', 'Checklist'];
        let filledSections = 0;
        for (const sec of expectedSections) {
          const secRegex = new RegExp(`^##\\s+.*${sec.replace(/-/g, '[- ]')}`, 'im');
          const secMatch = content.match(secRegex);
          if (secMatch) {
            const secIdx = content.indexOf(secMatch[0]);
            const afterHeader = content.slice(secIdx + secMatch[0].length, secIdx + secMatch[0].length + 200);
            const sectionContent = afterHeader.split(/^##\s/m)[0].trim();
            const sectionWords = sectionContent.split(/\s+/).filter(w => w.length > 1 && !w.startsWith('_No')).length;
            if (sectionWords >= 10) filledSections++;
          }
        }
        const fillRate = filledSections / expectedSections.length;
        return fillRate < 0.6; // Hollow if < 60% sections filled
      });
    }

    if (targetSkills.length === 0) {
      return `✅ No skills to enrich. All skills are well-populated.`;
    }

    const skillNames = targetSkills.map(s => s.name);
    const lines = [
      `## 🌐 Batch Skill Enrichment ${dryRun ? '(Dry Run Preview)' : 'Started'}`,
      ``,
      `- **Target skills**: ${skillNames.length}`,
      `- **Mode**: ${hollowOnly ? 'Hollow/thin only' : 'ALL skills'}`,
      `- **Concurrency**: ${concurrency} (enrichment pipeline rate-limited)`,
      `- **Dry run**: ${dryRun ? 'Yes (no files will be modified)' : 'No (skills will be updated)'}`,
      ``,
    ];

    if (dryRun) {
      lines.push(`### Skills that would be enriched:`);
      for (const name of skillNames) {
        lines.push(`- \`${name}\``);
      }
      lines.push(``, `> 💡 Run \`/skill-enrich-all${hollowOnly ? ' --hollow-only' : ''}\` (without --dry-run) to execute.`);
      return lines.join('\n');
    }

    // Execute enrichment in batches to respect rate limits
    const { enrichSkillFromExternalKnowledge } = require('../core/context-budget-manager');

    lines.push(`### Progress:`);
    lines.push(`| # | Skill | Status | Entries | Sources | Time |`);
    lines.push(`|---|-------|--------|---------|---------|------|`);

    const results = [];
    const startTime = Date.now();

    // Process skills in batches of `concurrency`
    for (let i = 0; i < skillNames.length; i += concurrency) {
      const batch = skillNames.slice(i, i + concurrency);
      const batchPromises = batch.map(async (name) => {
        const t0 = Date.now();
        try {
          const result = await enrichSkillFromExternalKnowledge(context.orchestrator, name, {});
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          return {
            name,
            success: result.success,
            sectionsAdded: result.sectionsAdded || 0,
            sources: (result.sources || []).length,
            elapsed,
            error: result.error || null,
          };
        } catch (err) {
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          return { name, success: false, sectionsAdded: 0, sources: 0, elapsed, error: err.message };
        }
      });
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Log progress
      for (const r of batchResults) {
        const status = r.success ? '✅' : '❌';
        console.log(`[SkillEnrichAll] ${status} ${r.name}: ${r.sectionsAdded} entries, ${r.sources} sources, ${r.elapsed}s${r.error ? ` (${r.error})` : ''}`);
      }
    }

    // Build result table
    for (let idx = 0; idx < results.length; idx++) {
      const r = results[idx];
      const status = r.success ? '✅ OK' : `❌ ${(r.error || 'failed').slice(0, 30)}`;
      lines.push(`| ${idx + 1} | ${r.name} | ${status} | ${r.sectionsAdded} | ${r.sources} | ${r.elapsed}s |`);
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    const totalEntries = results.reduce((sum, r) => sum + r.sectionsAdded, 0);

    lines.push(``);
    lines.push(`### Summary`);
    lines.push(`- ✅ **Succeeded**: ${successCount}/${results.length}`);
    lines.push(`- ❌ **Failed**: ${failCount}`);
    lines.push(`- 📝 **Total entries added**: ${totalEntries}`);
    lines.push(`- ⏱️ **Total time**: ${totalElapsed}s`);

    if (failCount > 0) {
      lines.push(``);
      lines.push(`### Failed Skills:`);
      for (const r of results.filter(r => !r.success)) {
        lines.push(`- \`${r.name}\`: ${r.error}`);
      }
    }

    return lines.join('\n');
  }
);



}

module.exports = { registerSkillsCommands };
