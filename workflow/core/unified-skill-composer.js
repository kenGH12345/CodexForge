const path = require('path');
const { buildSkillYFM, SkillYFMBuilderError } = require('./skill-yfm-builder');

class UnifiedSkillComposer {
  constructor(projectRoot, opts = {}) {
    this.projectRoot = projectRoot;
    this.projectName = opts.projectName || path.basename(projectRoot);
    this.tokenLimit = opts.tokenLimit || 3000;
  }

  compose({ conventions, architecture, components, sources = [] }) {
    const frontmatter = this._composeFrontmatter(sources);
    const body = this._composeBody({ conventions, architecture, components });
    return frontmatter + '\n' + body;
  }

  _composeFrontmatter(sources) {
    const skillName = `${this.projectName} Skill Knowledge`;
    const projectKey = this.projectName.toLowerCase().replace(/\s+/g, '-');
    const effectiveSources = sources.length > 0 ? sources : ['skill-ai-generator', 'skill-discovery'];

    // Build triggers.keywords from: projectName tokens + sources
    const kwSet = new Set();
    kwSet.add(projectKey);
    kwSet.add(this.projectName);
    for (const tok of this.projectName.split(/[-_\s]+/)) if (tok.length > 1) kwSet.add(tok.toLowerCase());
    for (const s of effectiveSources) kwSet.add(String(s));
    kwSet.add('project-knowledge');
    const keywords = Array.from(kwSet).filter(Boolean).slice(0, 10);

    const description = `Unified project knowledge skill for ${this.projectName} — fused from ${effectiveSources.length} source(s): ${effectiveSources.join(', ')}. Covers conventions, architecture patterns, and reusable components discovered through static analysis.`;

    try {
      const yfm = buildSkillYFM({
        name: skillName,
        version: '1.0.0',
        type: 'project-knowledge',
        description,
        domains: [projectKey, 'project-knowledge'],
        triggers: { keywords, roles: ['developer', 'architect'] },
        load_level: 'session',
        max_tokens: this.tokenLimit,
        generatedAt: new Date().toISOString(),
      });
      // Append composer-specific extras (project/sources/deprecated) AFTER builder's YFM.
      // We must merge them INTO the same `---` block — so remove the trailing `---\n` and re-add.
      const trimmed = yfm.replace(/\n---\n*$/, '\n');
      const extras = [
        `project: ${projectKey}`,
        `sources:`,
        ...effectiveSources.map(s => `  - ${s}`),
        `deprecated: false`,
      ].join('\n');
      return `${trimmed}${extras}\n---\n`;
    } catch (err) {
      if (err instanceof SkillYFMBuilderError) {
        console.error(`[UnifiedSkillComposer] YFM builder rejected input: ${err.message}; falling back to minimal YFM`);
      } else {
        throw err;
      }
      // Disaster fallback: minimal YFM that still registers via ConfigLoader
      const now = new Date().toISOString();
      return [
        '---',
        `name: ${skillName}`,
        `type: project-knowledge`,
        `version: 1.0.0`,
        `description: ${description}`,
        `domains: [${projectKey}, project-knowledge]`,
        `triggers:`,
        `  keywords:`,
        ...keywords.map(k => `    - ${k}`),
        `  roles:`,
        `    - developer`,
        `project: ${projectKey}`,
        `sources:`,
        ...effectiveSources.map(s => `  - ${s}`),
        `deprecated: false`,
        `generated_at: ${now}`,
        '---',
        '',
      ].join('\n');
    }
  }

  _simpleYamlDump(obj) {
    const lines = [];
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${item}`);
      } else if (typeof value === 'boolean') {
        lines.push(`${key}: ${value}`);
      } else if (typeof value === 'object') {
        continue;
      } else {
        lines.push(`${key}: ${String(value)}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  _composeBody({ conventions, architecture, components }) {
    const parts = [];
    parts.push(this._formatSection('Conventions', conventions));
    parts.push(this._formatSection('Architecture', architecture));
    parts.push(this._formatSection('Components', components));
    return parts.filter(Boolean).join('\n\n');
  }

  _formatSection(title, content) {
    if (!content || (typeof content === 'string' && !content.trim())) return '';
    const body = typeof content === 'string' ? content.trim() : JSON.stringify(content, null, 2);
    return `## ${title}\n\n${body}`;
  }

  static extractSection(markdown, sectionName) {
    const lines = markdown.split(/\r?\n/);
    let inSection = false;
    let buffer = [];
    const normalizedName = sectionName.toLowerCase().replace(/\s+/g, ' ');
    for (const line of lines) {
      const heading = line.match(/^##+\s+(.+)$/);
      if (heading) {
        if (inSection) break;
        const currentName = heading[1].trim().toLowerCase().replace(/\s+/g, ' ');
        if (currentName === normalizedName) inSection = true;
        continue;
      }
      if (inSection) buffer.push(line);
    }
    return buffer.join('\n').trim();
  }

  static parseFrontmatter(markdown) {
    const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return { __content: markdown };
    const front = {};
    for (const line of match[1].split(/\r?\n/)) {
      const arr = line.match(/^(\S+?):\s*\[([\s\S]*)\]$/);
      if (arr) {
        front[arr[1]] = arr[2].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        continue;
      }
      const kv = line.match(/^(\S+?):\s*(.+)$/);
      if (kv) {
        const v = kv[2].trim();
        front[kv[1]] = v === 'true' ? true : v === 'false' ? false : v;
      }
    }
    front.__content = match[2];
    return front;
  }
}

module.exports = UnifiedSkillComposer;
