'use strict';

const fs = require('fs');
const path = require('path');
const { getDefaultOutputDir } = require('./constants');

// ─── Socratic Effect Tracker ──────────────────────────────────────

const LOG_DIR = getDefaultOutputDir();
const LOG_FILE = path.join(LOG_DIR, 'socratic-effect-log.jsonl');

function _ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function _appendLog(record) {
  _ensureLogDir();
  fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n');
}

function _computeEffectDelta(preConfidence, postConfidence) {
  const preOverall = typeof preConfidence === 'object' ? (preConfidence.overall || 0) : (preConfidence || 0);
  const postOverall = typeof postConfidence === 'object' ? (postConfidence.overall || 0) : (postConfidence || 0);
  const deltaOverall = +(postOverall - preOverall).toFixed(4);

  const preDims = typeof preConfidence === 'object' ? (preConfidence.dimensions || {}) : {};
  const postDims = typeof postConfidence === 'object' ? (postConfidence.dimensions || {}) : {};
  const deltaDimensions = {};
  const allKeys = new Set([...Object.keys(preDims), ...Object.keys(postDims)]);
  for (const key of allKeys) {
    deltaDimensions[key] = +((postDims[key] || 0) - (preDims[key] || 0)).toFixed(4);
  }

  return { deltaOverall, deltaDimensions };
}

function recordPre(stage, artifact, confidenceResult) {
  const preConfidence = (confidenceResult && typeof confidenceResult === 'object') ? (confidenceResult.overall != null ? confidenceResult.overall : null) : null;
  const preDimensions = (confidenceResult && typeof confidenceResult === 'object') ? (confidenceResult.dimensions || {}) : {};
  const record = {
    type: 'pre',
    sessionId: process.env.WF_SESSION_ID || null,
    stage,
    artifact: artifact ? String(artifact).slice(0, 200) : null,
    preConfidence,
    preDimensions,
    timestamp: new Date().toISOString(),
  };
  _appendLog(record);
  return record;
}

function recordPost(preRecord, postConfidenceResult, blindSpotsAfter) {
  const postConfidence = (postConfidenceResult && typeof postConfidenceResult === 'object') ? (postConfidenceResult.overall != null ? postConfidenceResult.overall : null) : null;
  const postDimensions = (postConfidenceResult && typeof postConfidenceResult === 'object') ? (postConfidenceResult.dimensions || {}) : {};
  const { deltaOverall, deltaDimensions } = _computeEffectDelta(
    { overall: preRecord.preConfidence, dimensions: preRecord.preDimensions },
    { overall: postConfidence, dimensions: postDimensions }
  );
  const record = {
    type: 'post',
    sessionId: preRecord.sessionId,
    stage: preRecord.stage,
    artifact: preRecord.artifact,
    preConfidence: preRecord.preConfidence,
    postConfidence,
    deltaOverall,
    deltaDimensions,
    blindSpotsAfter: blindSpotsAfter || [],
    timestamp: new Date().toISOString(),
  };
  _appendLog(record);
  return record;
}

function recordAdoption(effectRecord, adopted) {
  const adoptionRecord = {
    type: 'adoption',
    sessionId: effectRecord.sessionId,
    stage: effectRecord.stage,
    artifact: effectRecord.artifact,
    adopted,
    adoptionTimestamp: new Date().toISOString(),
  };
  _appendLog(adoptionRecord);
  effectRecord.adopted = adopted;
  return effectRecord;
}

function getEffectLog(sessionId) {
  _ensureLogDir();
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean);
  const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (sessionId) return records.filter(r => r.sessionId === sessionId);
  return records;
}

module.exports = {
  recordPre,
  recordPost,
  recordAdoption,
  computeEffectDelta: _computeEffectDelta,
  getEffectLog,
};
