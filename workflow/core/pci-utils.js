'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const DEFAULT_PREVIEW_CHARS = 240;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeContent(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_#>|\-[\](){},.;:!?'"\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function estimateTokens(value) {
  return Math.ceil(String(value || '').length / 4);
}

function safeRead(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return '';
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function sourceHash(filePath) {
  const content = safeRead(filePath);
  return content ? sha256(content) : null;
}

function rel(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function collectFiles(dir, predicate, bucket = []) {
  if (!dir || !fs.existsSync(dir)) return bucket;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return bucket; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(abs, predicate, bucket);
    else if (entry.isFile() && predicate(abs, entry.name)) bucket.push(abs);
  }
  return bucket;
}

function createCollector(projectRoot) {
  const blocks = [];
  const seenIds = new Set();

  function addBlock(input) {
    const content = String(input.content || '').trim();
    if (!content) return null;
    const normalized = normalizeContent(content);
    if (!normalized) return null;
    const baseId = String(input.id || `${input.type}.${blocks.length + 1}`).replace(/[^a-zA-Z0-9_.:-]+/g, '-');
    let id = baseId;
    let suffix = 2;
    while (seenIds.has(id)) id = `${baseId}.${suffix++}`;
    seenIds.add(id);

    const block = {
      id,
      type: input.type || 'unknown',
      owner: input.owner || 'unknown',
      source: input.source || null,
      sourceHash: input.sourcePath ? sourceHash(input.sourcePath) : input.sourceHash || null,
      version: input.version || '1',
      stage: Array.isArray(input.stage) ? input.stage : [],
      role: Array.isArray(input.role) ? input.role : [],
      priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 50,
      dedupePolicy: input.dedupePolicy || 'semantic-shadow',
      dedupeKey: `normalized:${sha256(normalized).slice(0, 16)}`,
      contentHash: sha256(content),
      normalizedHash: sha256(normalized),
      tokenEstimate: estimateTokens(content),
      charCount: content.length,
      preview: content.slice(0, DEFAULT_PREVIEW_CHARS),
    };
    blocks.push(block);
    return block;
  }

  return { blocks, addBlock };
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_PREVIEW_CHARS,
  sha256,
  normalizeContent,
  estimateTokens,
  safeRead,
  sourceHash,
  rel,
  collectFiles,
  createCollector,
};
