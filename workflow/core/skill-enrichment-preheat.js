/**
 * Experience Store Preheating
 *
 * Extracted from skill-enrichment.js for maintainability (ADR-41).
 * Contains cold-start preheating logic for the ExperienceStore.
 *
 * @module workflow/core/skill-enrichment-preheat
 */

'use strict';

const { webSearchHelper } = require('./web-search-helpers');

/**
 * Preheats the ExperienceStore with seed experiences from external knowledge.
 *
 * This function addresses the cold-start problem by searching for common
 * patterns, pitfalls, and best practices for the project's tech stack,
 * then using LLM analysis to generate structured experiences.
 *
 * @param {Orchestrator} orch - Orchestrator instance
 * @param {object} [opts]
 * @param {number} [opts.maxResults=5] - Max search results per query
 * @param {string[]} [opts.techStack=[]] - Project tech stack
 * @param {string} [opts.projectType=''] - Project type
 * @param {object} [opts.experienceStore] - ExperienceStore instance (optional)
 * @param {Function} [opts.llmCall] - LLM call function (optional)
 * @param {object} [opts.mcpRegistry] - MCP registry (optional)
 * @returns {Promise<{success: boolean, seeded: number, error?: string}>}
 */
async function preheatExperienceStore(orch, opts = {}) {
  const { maxResults = 5, techStack = [], projectType = '' } = opts;
  const startTime = Date.now();

  try {
    // A-2 architecture fix: Resolve dependencies via service locator pattern.
    // All downstream code uses these local variables instead of accessing orch directly.
    const experienceStore = opts.experienceStore || orch.experienceStore || null;
    const llmCall         = opts.llmCall || orch._rawLlmCall || orch.llmCall || null;
    let mcpRegistry       = opts.mcpRegistry || null;
    if (!mcpRegistry && orch.services) {
try {
        mcpRegistry = orch.services.resolve('mcpRegistry');
      } catch (e) {
        // MCP registry not available or not configured — proceed without it
      }
    }

    if (!experienceStore) {
      return { success: false, seeded: 0, error: 'ExperienceStore not available' };
    }

    // Only preheat if the store is empty or nearly empty (< 3 entries)
    const stats = experienceStore.getStats();
    if (stats.total >= 3) {
      console.log(`[ExpPreheat] ℹ️  Experience store already has ${stats.total} entries. Skipping preheat.`);
      return { success: true, seeded: 0 };
    }

    console.log(`[ExpPreheat] 🌱 Starting experience store cold-start preheating...`);
    console.log(`[ExpPreheat]    Tech stack: [${techStack.join(', ')}]`);
    console.log(`[ExpPreheat]    Project type: ${projectType || 'general'}`);

    // FIX(Defect #1): Construct multi-dimensional search queries (was 2-3, now 4-5)
    // Mirrors the 5-dimension strategy from enrichSkillFromExternalKnowledge
    const queries = [];
    if (techStack.length > 0) {
      const techTerms = techStack.slice(0, 4).join(' ');
      // Dimension 1: Common pitfalls and gotchas
      queries.push(`${techTerms} common pitfalls gotchas mistakes developers make 2025 2026`);
      // Dimension 2: Best practices and stable patterns
      queries.push(`${techTerms} best practices stable patterns production tips`);
      // Dimension 3: Performance and debugging
      queries.push(`${techTerms} performance optimization debugging lessons learned production`);
      // Dimension 4: Security concerns
      queries.push(`${techTerms} security vulnerabilities common attacks prevention`);
    }
    if (projectType) {
      // Dimension 5: Project-type-specific patterns
      queries.push(`${projectType} development common anti-patterns pitfalls architecture mistakes`);
    }
    // Always include a general software engineering query as fallback
    if (queries.length === 0) {
      queries.push('software development common pitfalls anti-patterns best practices 2025');
    }

    // FIX(Defect #1): Search up to 5 queries in parallel (was 3)
    const allResults = [];
    const searchPromises = queries.slice(0, 5).map(q =>
      webSearchHelper(orch, q, { maxResults, label: 'ExpPreheat' })
    );
    const rawResults = await Promise.all(searchPromises);
    for (const r of rawResults) {
      if (r && r.results) allResults.push(...r.results);
    }

    // Deduplicate by URL
    const seen = new Set();
    const uniqueResults = allResults.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    if (uniqueResults.length === 0) {
      console.log(`[ExpPreheat] ⚠️  No search results found. Cannot preheat.`);
      return { success: false, seeded: 0, error: 'No search results' };
    }

    console.log(`[ExpPreheat] 📊 Found ${uniqueResults.length} unique results. Deep-fetching top pages...`);

    // FIX(Defect #1): Deep-fetch top pages for richer content (was snippet-only)
    // Mirrors the deep-fetch strategy from enrichSkillFromExternalKnowledge
    const maxFetchPages = 3;
    const pagesToFetch = uniqueResults.slice(0, maxFetchPages);
    let wsAdapter = null;
    try {
      if (mcpRegistry) wsAdapter = mcpRegistry.get('websearch');
    } catch (_) { /* no adapter */ }

    let fetchedContent = '';
    const sources = [];
    if (wsAdapter && wsAdapter.fetchPage) {
      const fetchPromises = pagesToFetch.map(r =>
        wsAdapter.fetchPage(r.url, { maxLength: 6000 }).catch(() => ({ url: r.url, content: '' }))
      );
      const pages = await Promise.all(fetchPromises);
      for (const page of pages) {
        if (page.content && page.content.length > 100) {
          fetchedContent += `\n\n--- Source: ${page.url} ---\n${page.content}`;
          sources.push(page.url);
        }
      }
    }

    // Fallback: use snippets if deep-fetch unavailable (but with more content than before)
    if (!fetchedContent) {
      fetchedContent = uniqueResults.slice(0, 8).map(r =>
        `--- Source: ${r.url} ---\n${r.title}\n${(r.snippet || '').slice(0, 500)}`
      ).join('\n\n');
      sources.push(...uniqueResults.slice(0, 8).map(r => r.url));
    }

    console.log(`[ExpPreheat] 📄 Fetched content: ${fetchedContent.length} chars from ${sources.length} source(s)`);

    // FIX(Defect #1): Significantly enhanced prompt with content depth requirements,
    // quality gates, and examples — mirrors the quality standards from enrichment prompts
    const analysisPrompt = [
      `You are a senior software engineer with deep production experience. Analyse the source`,
      `content below and extract actionable experiences for a developer working on a`,
      `${projectType || 'software'} project${techStack.length > 0 ? ` using ${techStack.join(', ')}` : ''}.`,
      ``,
      `## Output Format`,
      `Return ONLY a JSON array (no markdown fences, no explanation):`,
      `[`,
      `  {`,
      `    "type": "positive" | "negative",`,
      `    "category": "pitfall" | "stable_pattern" | "performance" | "framework_limit" | "debug_technique" | "security",`,
      `    "title": "<concise imperative title, e.g. 'Always use parameterized queries in SQL'>",`,
      `    "content": "<4-6 sentence SUBSTANTIAL description (see Content Depth below)>",`,
      `    "tags": ["<relevant", "keywords"]`,
      `  }`,
      `]`,
      ``,
      `## Content Depth Requirements`,
      `Each experience's "content" field MUST be 4-6 sentences and include ALL of:`,
      `1. **What**: The specific situation, pattern, or problem`,
      `2. **Why**: Why it matters (consequence of ignoring / benefit of following)`,
      `3. **How**: Concrete action to take or avoid (with code pattern if applicable)`,
      `4. **Context**: When this applies (specific versions, environments, scale thresholds)`,
      ``,
      `## Quality Gates (entries that fail these are REJECTED)`,
      `- ❌ REJECT vague platitudes: "Write clean code", "Follow best practices"`,
      `- ❌ REJECT entries without concrete actions: "Be careful with X"`,
      `- ❌ REJECT one-liner or two-liner content — MINIMUM 4 sentences`,
      `- ✅ ACCEPT only entries where a developer can ACT immediately`,
      ``,
      `## Examples`,
      ``,
      `### ✅ Good Entry (follows all rules):`,
      `{`,
      `  "type": "negative",`,
      `  "category": "pitfall",`,
      `  "title": "Never use string concatenation for SQL queries",`,
      `  "content": "String-concatenated SQL queries are vulnerable to SQL injection attacks, which remain the #1 web application vulnerability (OWASP Top 10). Even in internal tools, an attacker who gains limited access can escalate privileges through injection. Always use parameterized queries or prepared statements: db.query('SELECT * FROM users WHERE id = ?', [userId]) instead of db.query('SELECT * FROM users WHERE id = ' + userId). ORMs like Sequelize and TypeORM handle this automatically, but raw query escape hatches still need manual parameterization.",`,
      `  "tags": ["sql", "security", "injection", "database"]`,
      `}`,
      ``,
      `### ❌ Bad Entry (too vague, no depth):`,
      `{`,
      `  "type": "negative",`,
      `  "category": "pitfall",`,
      `  "title": "Be careful with SQL",`,
      `  "content": "SQL injection is a common problem. Use parameterized queries.",`,
      `  "tags": ["sql"]`,
      `}`,
      ``,
      `## Generation Rules`,
      `- Generate 8-12 experiences (mix of positive and negative, at least 3 of each)`,
      `- Include at least 1 entry per category that is relevant to the tech stack`,
      `- Pitfalls: describe what goes wrong, the specific consequence, and the exact fix`,
      `- Stable patterns: describe the pattern, WHY it's stable, measured/estimated benefit`,
      `- Performance: include specific thresholds or benchmarks when possible`,
      `- Security: cite specific vulnerability types (CWE/OWASP when applicable)`,
      `- Tags should include technology names, versions, and relevant concepts`,
      ``,
      `## Source Content`,
      fetchedContent.slice(0, 20000),
    ].join('\n');

    let experiences = null;
    if (llmCall) {
      const llmResponse = await llmCall(analysisPrompt);
      experiences = _parsePreheatResponse(llmResponse);
    }

    if (!experiences || experiences.length === 0) {
      console.log(`[ExpPreheat] ⚠️  LLM analysis did not produce valid experiences.`);
      return { success: false, seeded: 0, error: 'LLM analysis produced no experiences' };
    }

    // Inject experiences into the store
    const { ExperienceType, ExperienceCategory } = require('./experience-store');
    let seeded = 0;
    for (const exp of experiences) {
      try {
        const type = exp.type === 'positive' ? ExperienceType.POSITIVE : ExperienceType.NEGATIVE;
        const categoryMap = {
          'pitfall': ExperienceCategory.PITFALL,
          'stable_pattern': ExperienceCategory.STABLE_PATTERN,
          'performance': ExperienceCategory.PERFORMANCE,
          'framework_limit': ExperienceCategory.FRAMEWORK_LIMIT,
          'debug_technique': ExperienceCategory.DEBUG_TECHNIQUE,
        };
        const category = categoryMap[exp.category] || ExperienceCategory.STABLE_PATTERN;

        experienceStore.record({
          type,
          category,
          title: exp.title,
          content: `${exp.content}\n> _Source: cold-start-preheat (external-search)_`,
          tags: exp.tags || [],
          ttlDays: type === ExperienceType.NEGATIVE ? 90 : 180, // Shorter TTL for seeded experiences
        });
        seeded++;
      } catch (recErr) {
        console.warn(`[ExpPreheat] ⚠️  Failed to record experience "${exp.title}": ${recErr.message}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[ExpPreheat] ✅ Experience store preheated: ${seeded} seed experiences injected in ${elapsed}s`);
    return { success: true, seeded };

  } catch (err) {
    console.warn(`[ExpPreheat] ❌ Preheating failed: ${err.message}`);
    return { success: false, seeded: 0, error: err.message };
  }
}

/**
 * Parses the LLM response for experience preheating.
 * Handles both raw JSON arrays and markdown-fenced JSON.
 */
function _parsePreheatResponse(response) {
  if (!response || typeof response !== 'string') return null;
  try {
    let cleaned = response.trim();
    // Strip markdown fences
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    // Find JSON array boundaries
    const startIdx = cleaned.indexOf('[');
    const endIdx = cleaned.lastIndexOf(']');
    if (startIdx === -1 || endIdx === -1) return null;
    cleaned = cleaned.slice(startIdx, endIdx + 1);

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return null;

    // Validate each entry
    // FIX(Defect #1): Increased cap from 10 to 15 to match expanded generation target
    return parsed.filter(e =>
      e && typeof e === 'object' &&
      e.title && typeof e.title === 'string' &&
      e.content && typeof e.content === 'string' &&
      (e.type === 'positive' || e.type === 'negative')
    ).slice(0, 15);
  } catch (err) {
    console.warn(`[ExpPreheat] ⚠️  Failed to parse LLM response: ${err.message}`);
    return null;
  }
}

module.exports = {
  preheatExperienceStore,
};
