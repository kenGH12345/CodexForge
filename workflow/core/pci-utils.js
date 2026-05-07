'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;

function rel(projectRoot, filePath) {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

function createCollector(projectRoot) {
  const blocks = [];
  return {
    blocks,
    projectRoot,
    addBlock(block) { blocks.push(block); },
  };
}

function normalizeContent(content) {
  if (!content) return '';
  return content
    .replace(/[\r\n]+/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function readJsonArtifact(projectRoot, relPath) {
  const filePath = path.join(projectRoot, relPath);
  try {
    if (!fs.existsSync(filePath)) return { exists: false, path: filePath, value: null, error: `${relPath} not found` };
    return { exists: true, path: filePath, value: JSON.parse(fs.readFileSync(filePath, 'utf-8')), error: null };
  } catch (err) {
    return { exists: false, path: filePath, value: null, error: err.message };
  }
}

function asFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function readPathValue(object, paths) {
  for (const pathExpr of paths) {
    const value = String(pathExpr).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), object);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function formatPercent(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function formatNumber(value, digits = 2) {
  return value == null ? 'n/a' : Number(value).toFixed(digits);
}

module.exports = {
  SCHEMA_VERSION,
  rel,
  safeRead,
  createCollector,
  normalizeContent,
  readJsonArtifact,
  asFiniteNumber,
  readPathValue,
  formatPercent,
  formatNumber,
};
