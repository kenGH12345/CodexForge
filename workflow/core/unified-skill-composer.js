const path = require('path');

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
    const now = new Date().toISOString();
    const meta = {
      name: `${this.projectName} Skill Knowledge`,
      project: this.projectName.toLowerCase(),
      type: 'project-knowledge',
      version: '1.0.0',
      generated_at: now,
      sources: sources.length > 0 ? sources : ['skill-ai-generator', 'skill-discovery'],
      deprecated: false
    };
    return '---\n' + this._simpleYamlDump(meta) + '---\n';
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
