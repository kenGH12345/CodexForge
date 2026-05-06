'use strict';

const fs = require('fs');
const path = require('path');

const SHARDING_FILES = [
  'SKILL.md',
  'references/d1-structure.md',
  'references/d2-behavior.md',
  'references/d3-communication.md',
  'references/d4-contract.md',
];

const SHARDING_FILE_WHITELIST = new Set(SHARDING_FILES);

const SHARDING_SCHEMA = {
  maxMainLines: 300,
  maxReferenceLines: 350,
};

const SHARDING_HOME = [
  ['§1 项目概览', 'SKILL.md'],
  ['§2 项目流程与生命周期', 'references/d2-behavior.md'],
  ['§3 模块管理', 'references/d1-structure.md'],
  ['§4 设计模式', 'references/d2-behavior.md'],
  ['§5 架构框架（MVC/分层）', 'references/d1-structure.md'],
  ['§6 事件系统', 'references/d3-communication.md'],
  ['§7 状态管理', 'references/d2-behavior.md'],
  ['§8 配置与数据驱动', 'references/d4-contract.md'],
  ['§9 持久化与存档', 'references/d4-contract.md'],
  ['§10 网络通信', 'references/d3-communication.md'],
  ['§11 日志系统', 'references/d2-behavior.md'],
  ['§12 公共组件与工具库', 'references/d1-structure.md'],
  ['§13 MVC 数据流与绑定', 'references/d3-communication.md'],
  ['§14 模块间通讯契约', 'references/d3-communication.md'],
  ['§15 协议与契约定义', 'references/d4-contract.md'],
  ['§M-1 错误处理与容错', 'references/d4-contract.md'],
  ['§M-2 修改影响半径', 'references/d3-communication.md'],
  ['§M-3 新人 Onboarding', 'SKILL.md'],
];

function normalizeRelPath(relPath) {
  return String(relPath || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function assembleShardingPromptBlock() {
  const lines = [];
  lines.push('## v2.1 Sharded Output Contract');
  lines.push('');
  lines.push('Produce markdown split into file blocks using EXACT delimiter lines:');
  lines.push('');
  for (const file of SHARDING_FILES) {
    lines.push(`=== FILE: ${file} ===`);
    lines.push(`<content for ${file}>`);
    lines.push('');
  }
  lines.push('Rules:');
  lines.push(`- \`SKILL.md\` <= ${SHARDING_SCHEMA.maxMainLines} lines; each reference file <= ${SHARDING_SCHEMA.maxReferenceLines} lines.`);
  lines.push('- `SKILL.md` contains ONLY YAML frontmatter, §1 overview, §M-3 onboarding, navigation table, and sharding self-check matrix.');
  lines.push('- Detailed single-quadrant content MUST go into `references/*.md`, not into `SKILL.md`.');
  lines.push('- Use relative cross-links such as `[§5](references/d1-structure.md#5-架构框架)` from SKILL.md and `[§14](./d3-communication.md#14-模块间通讯契约)` inside references.');
  lines.push('');
  lines.push('Section homes (MUST follow):');
  lines.push('| Section | File |');
  lines.push('|---|---|');
  for (const [section, file] of SHARDING_HOME) {
    lines.push(`| ${section} | \`${file}\` |`);
  }
  return lines.join('\n');
}

function parseShardedOutput(text) {
  const content = String(text || '').replace(/\r\n/g, '\n');
  const markerRe = /^=== FILE:\s*([^=\n]+?)\s*===\s*$/gm;
  const matches = [];
  let match;
  while ((match = markerRe.exec(content)) !== null) {
    matches.push({ path: normalizeRelPath(match[1]), start: match.index, end: markerRe.lastIndex });
  }

  if (matches.length === 0) {
    return {
      files: new Map([['SKILL.md', content.trim()]]),
      parseMode: 'single',
      warnings: ['No sharding delimiter found; treated output as single SKILL.md'],
    };
  }

  const files = new Map();
  const warnings = [];
  const prefix = content.slice(0, matches[0].start).trim();
  if (prefix) warnings.push('Ignored content before first FILE delimiter');

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const body = content.slice(current.end, next ? next.start : content.length).trim();
    if (!SHARDING_FILE_WHITELIST.has(current.path)) {
      warnings.push(`Unexpected sharding path: ${current.path}`);
    }
    files.set(current.path, body);
  }

  if (!files.has('SKILL.md')) {
    return { files, parseMode: 'malformed', warnings: warnings.concat('Missing SKILL.md block') };
  }

  return { files, parseMode: files.size > 1 ? 'sharded' : 'single', warnings };
}

function validateSharding(filesLike) {
  const files = filesLike instanceof Map ? filesLike : new Map(Object.entries(filesLike || {}));
  const warnings = [];
  const errors = [];

  if (!files.has('SKILL.md')) errors.push('Missing SKILL.md');

  for (const [relPath, content] of files.entries()) {
    const normalized = normalizeRelPath(relPath);
    if (normalized.includes('..') || path.isAbsolute(normalized)) {
      errors.push(`Unsafe sharding path: ${relPath}`);
      continue;
    }
    const lineCount = String(content || '').split(/\r?\n/).length;
    if (normalized === 'SKILL.md' && lineCount > SHARDING_SCHEMA.maxMainLines) {
      warnings.push(`SKILL.md has ${lineCount} lines (limit ${SHARDING_SCHEMA.maxMainLines})`);
    }
    if (normalized.startsWith('references/') && lineCount > SHARDING_SCHEMA.maxReferenceLines) {
      warnings.push(`${normalized} has ${lineCount} lines (limit ${SHARDING_SCHEMA.maxReferenceLines})`);
    }
  }

  const linkRe = /\[[^\]]+\]\(([^)]+\.md)(#[^)]+)?\)/g;
  for (const [relPath, content] of files.entries()) {
    let match;
    while ((match = linkRe.exec(String(content || ''))) !== null) {
      const rawTarget = normalizeRelPath(match[1]);
      const target = rawTarget.startsWith('../') ? normalizeRelPath(rawTarget.slice(3)) : normalizeRelPath(path.posix.join(path.posix.dirname(normalizeRelPath(relPath)), rawTarget));
      if (!files.has(target) && SHARDING_FILE_WHITELIST.has(target)) {
        warnings.push(`Cross-reference target not present: ${relPath} -> ${target}`);
      }
    }
  }

  return { valid: errors.length === 0, warnings, errors };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function atomicWriteShardedSkill(targetDir, mainContent, referenceFiles = {}) {
  const stamp = `${Date.now()}-${process.pid}`;
  const tmpDir = `${targetDir}.tmp.${stamp}`;
  const bakDir = `${targetDir}.bak.${stamp}`;
  const refs = referenceFiles instanceof Map ? Object.fromEntries(referenceFiles) : referenceFiles;

  ensureDir(path.join(tmpDir, 'references'));
  fs.writeFileSync(path.join(tmpDir, 'SKILL.md'), String(mainContent || ''), 'utf8');

  for (const [relPath, content] of Object.entries(refs || {})) {
    const normalized = normalizeRelPath(relPath);
    if (normalized.includes('..') || path.isAbsolute(normalized)) {
      throw new Error(`Unsafe reference path: ${relPath}`);
    }
    const fullPath = path.join(tmpDir, normalized);
    ensureDir(path.dirname(fullPath));
    fs.writeFileSync(fullPath, String(content || ''), 'utf8');
  }

  if (fs.existsSync(targetDir)) fs.renameSync(targetDir, bakDir);
  try {
    fs.renameSync(tmpDir, targetDir);
  } catch (err) {
    if (err && (err.code === 'EXDEV' || err.code === 'EPERM')) {
      copyDir(tmpDir, targetDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } else {
      if (fs.existsSync(bakDir) && !fs.existsSync(targetDir)) fs.renameSync(bakDir, targetDir);
      throw err;
    }
  }

  return {
    targetDir,
    backupDir: fs.existsSync(bakDir) ? bakDir : null,
    filesWritten: 1 + Object.keys(refs || {}).length,
  };
}

module.exports = {
  SHARDING_FILES,
  SHARDING_FILE_WHITELIST,
  SHARDING_SCHEMA,
  SHARDING_HOME,
  assembleShardingPromptBlock,
  parseShardedOutput,
  validateSharding,
  atomicWriteShardedSkill,
};
