/**
 * Skill YFM Builder — single source of truth for SKILL.md front-matter.
 *
 * WHY this exists:
 *   Before, 5 different code paths (skill-ai-generator ×3, unified-skill-composer ×1,
 *   skill-author-guide.md ×1) each built their own YFM string with inconsistent fields.
 *   Result: newly generated project-expert skills routinely missed `triggers.keywords`,
 *   `type`, `load_level`, `max_tokens` — making them invisible to ContextLoader's BM25
 *   matcher. This module is the one place where YFM is rendered.
 *
 * Contract:
 *   - buildSkillYFM(input) → validates input against FIELD_SCHEMA, renders YFM string.
 *   - buildSkillYFMTemplate() → returns placeholder template for use in LLM prompts.
 *   - Hard-fails on missing required fields (better than silent degradation).
 *
 * End-to-end guarantee:
 *   The output is round-trippable: config-loader._extractSkillMetadata() must be able
 *   to read every field back. See skill-generator-yfm.test.js for the contract tests.
 */

class SkillYFMBuilderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkillYFMBuilderError';
  }
}

const TYPE_ENUM = ['project-expert-skill', 'project-knowledge', 'domain-skill', 'meta-skill'];
const LOAD_LEVEL_ENUM = ['session', 'task', 'on-demand'];
const MIN_KEYWORDS = 3;
const MIN_DESCRIPTION_LENGTH = 20;

const FIELD_SCHEMA = {
  name:         { required: true,  type: 'string' },
  version:      { required: false, type: 'string',  default: '1.0.0' },
  type:         { required: false, type: 'string',  default: 'project-expert-skill', enum: TYPE_ENUM },
  description:  { required: true,  type: 'string',  multiline: true, minLength: MIN_DESCRIPTION_LENGTH },
  domains:      { required: false, type: 'array',   default: [] },
  triggers:     { required: true,  type: 'object' },
  load_level:   { required: false, type: 'string',  default: 'session', enum: LOAD_LEVEL_ENUM },
  max_tokens:   { required: false, type: 'number',  default: 2000 },
  generatedAt:  { required: false, type: 'string' },
  llmPowered:   { required: false, type: 'boolean' },
};

function buildSkillYFM(input) {
  if (!input || typeof input !== 'object') {
    throw new SkillYFMBuilderError('input must be an object');
  }
  const merged = _applyDefaultsAndValidate(input);
  return _renderYFM(merged);
}

function buildSkillYFMTemplate() {
  const placeholder = {
    name: '<project-name-kebab-case>',
    version: '1.0.0',
    type: 'project-expert-skill',
    description: '<一句话说明本 skill 指导什么内容 / 适用场景；≥ 20 字；支持多行>',
    domains: ['<domain1>', '<domain2>', '<framework-name>'],
    triggers: {
      keywords: ['<项目名>', '<3-5 个项目特有术语>', '<2-3 个技术栈关键词>'],
      roles: ['developer', 'architect'],
    },
    load_level: 'session',
    max_tokens: 2000,
    generatedAt: '<ISO 8601 timestamp>',
    llmPowered: true,
  };
  return _renderYFM(placeholder, { skipValidation: true });
}

function _applyDefaultsAndValidate(input) {
  const merged = {};
  for (const [key, spec] of Object.entries(FIELD_SCHEMA)) {
    if (input[key] !== undefined && input[key] !== null) {
      merged[key] = input[key];
    } else if (spec.default !== undefined) {
      merged[key] = typeof spec.default === 'function' ? spec.default() : _cloneDefault(spec.default);
    }
  }

  if (!merged.name || typeof merged.name !== 'string' || merged.name.trim().length === 0) {
    throw new SkillYFMBuilderError('name is required and must be a non-empty string');
  }
  if (!merged.description || typeof merged.description !== 'string') {
    throw new SkillYFMBuilderError('description is required');
  }
  if (merged.description.trim().length < MIN_DESCRIPTION_LENGTH) {
    throw new SkillYFMBuilderError(`description too short (< ${MIN_DESCRIPTION_LENGTH} chars), got ${merged.description.trim().length}`);
  }
  if (!merged.triggers || typeof merged.triggers !== 'object') {
    throw new SkillYFMBuilderError('triggers is required and must be an object');
  }
  const keywords = merged.triggers.keywords;
  if (!Array.isArray(keywords) || keywords.length < MIN_KEYWORDS) {
    throw new SkillYFMBuilderError(`triggers.keywords must have ≥ ${MIN_KEYWORDS} items, got ${Array.isArray(keywords) ? keywords.length : 'non-array'}`);
  }
  if (!merged.triggers.roles || !Array.isArray(merged.triggers.roles) || merged.triggers.roles.length === 0) {
    merged.triggers.roles = ['developer'];
  }

  if (merged.type && !TYPE_ENUM.includes(merged.type)) {
    throw new SkillYFMBuilderError(`type '${merged.type}' not in enum [${TYPE_ENUM.join(', ')}]`);
  }
  if (merged.load_level && !LOAD_LEVEL_ENUM.includes(merged.load_level)) {
    throw new SkillYFMBuilderError(`load_level '${merged.load_level}' not in enum [${LOAD_LEVEL_ENUM.join(', ')}]`);
  }

  return merged;
}

function _cloneDefault(v) {
  if (Array.isArray(v)) return v.slice();
  if (v && typeof v === 'object') return { ...v };
  return v;
}

function _renderYFM(meta, opts = {}) {
  const lines = ['---'];
  const order = ['name', 'version', 'type', 'description', 'domains', 'triggers', 'load_level', 'max_tokens', 'generatedAt', 'llmPowered'];

  for (const key of order) {
    if (meta[key] === undefined || meta[key] === null) continue;
    const rendered = _renderField(key, meta[key]);
    if (rendered !== null) lines.push(rendered);
  }

  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function _renderField(key, value) {
  if (key === 'description' && typeof value === 'string' && (value.includes('\n') || value.length > 60)) {
    const body = value.split(/\r?\n/).map(l => `  ${l}`).join('\n');
    return `description: |\n${body}`;
  }

  if (key === 'triggers' && typeof value === 'object') {
    const out = ['triggers:'];
    if (Array.isArray(value.keywords)) {
      out.push('  keywords:');
      for (const kw of value.keywords) out.push(`    - ${_escapeListItem(kw)}`);
    }
    if (Array.isArray(value.roles)) {
      out.push('  roles:');
      for (const r of value.roles) out.push(`    - ${_escapeListItem(r)}`);
    }
    return out.join('\n');
  }

  if (Array.isArray(value)) {
    const items = value.map(v => _escapeListItem(v)).join(', ');
    return `${key}: [${items}]`;
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    return `${key}: ${value}`;
  }

  if (typeof value === 'string') {
    return `${key}: ${value}`;
  }

  return null;
}

function _escapeListItem(v) {
  const s = String(v);
  if (/[,\[\]]/.test(s)) return JSON.stringify(s);
  return s;
}

module.exports = {
  buildSkillYFM,
  buildSkillYFMTemplate,
  FIELD_SCHEMA,
  SkillYFMBuilderError,
  TYPE_ENUM,
  LOAD_LEVEL_ENUM,
  MIN_KEYWORDS,
  MIN_DESCRIPTION_LENGTH,
};
