'use strict';

const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config-loader');

const BS_STATUS = Object.freeze({ OPEN: 'OPEN', RESOLVED: 'RESOLVED', DEFERRED: 'DEFERRED' });

const DIMENSION_SEVERITY_MAP = Object.freeze({
  BOUNDARY: 'HIGH', EVIDENCE: 'HIGH', LOGIC: 'HIGH',
  DEPTH: 'MEDIUM', PRECISION: 'MEDIUM', CLARITY: 'MEDIUM',
  RELEVANCE: 'LOW', BREADTH: 'LOW', DATA: 'LOW',
  ROI_ASSESSMENT: 'LOW', FIRST_PRINCIPLES: 'MEDIUM',
});

const STAGE_VERIFICATION_MAP = Object.freeze({
  ANALYSE: ['ARCHITECT', 'PLAN'],
  ARCHITECT: ['PLAN', 'DEVELOP'],
  PLAN: ['DEVELOP', 'TEST'],
  DEVELOP: ['TEST', 'REVIEW'],
  TEST: ['REVIEW', 'DEPLOY'],
  REVIEW: ['DEPLOY'],
  DEPLOY: [],
});

class BlindSpotRegistry {
  constructor(projectRoot) {
    this._projectRoot = projectRoot;
    this._filePath = path.join(projectRoot, 'output', 'blind-spot-registry.json');
    this._entries = [];
    this._load();
  }

  register(entry) {
    if (!entry || !entry.evidence) return null;
    const dup = this._entries.find(e => e.evidence === entry.evidence && e.sessionId === entry.sessionId);
    if (dup) return dup;

    const stage = (entry.stage || 'UNKNOWN').toUpperCase();
    const seq = this._entries.filter(e => e.stage === stage).length + 1;
    const dimension = entry.dimension || this._inferDimension(entry.evidence);
    const severity = entry.severity || DIMENSION_SEVERITY_MAP[dimension] || 'LOW';

    const full = {
      id: `BS-${stage}-${String(seq).padStart(3, '0')}`,
      sessionId: entry.sessionId || '',
      stage,
      evidence: entry.evidence,
      severity,
      dimension,
      detectedAt: entry.detectedAt || new Date().toISOString(),
      status: BS_STATUS.OPEN,
      verificationTargets: entry.verificationTargets || STAGE_VERIFICATION_MAP[stage] || [],
      resolution: null,
    };
    this._entries.push(full);
    this._persist();
    return full;
  }

  getPendingForStage(stage) {
    const upper = (stage || '').toUpperCase();
    return this._entries.filter(e =>
      e.status === BS_STATUS.OPEN && (e.verificationTargets || []).includes(upper)
    );
  }

  resolve(id, resolution) {
    const entry = this._entries.find(e => e.id === id);
    if (!entry) return false;
    entry.status = BS_STATUS.RESOLVED;
    entry.resolution = resolution || {};
    this._persist();
    return true;
  }

  defer(id, reason) {
    const entry = this._entries.find(e => e.id === id);
    if (!entry) return false;
    entry.status = BS_STATUS.DEFERRED;
    entry.resolution = { reason: reason || '' };
    this._persist();
    return true;
  }

  autoResolveCheck(stage, artifactContent) {
    const upper = (stage || '').toUpperCase();
    const contentLower = String(artifactContent || '').toLowerCase();
    let resolved = 0;
    for (const entry of this._entries) {
      if (entry.status !== BS_STATUS.OPEN) continue;
      if (entry.severity === 'HIGH') continue;
      if (!(entry.verificationTargets || []).includes(upper)) continue;
      const keywords = this._extractKeywords(entry.evidence);
      if (keywords.length === 0) continue;
      const hit = keywords.filter(k => contentLower.includes(k.toLowerCase()));
      if (hit.length / keywords.length > 0.5) {
        entry.status = BS_STATUS.RESOLVED;
        entry.resolution = {
          stage: upper,
          evidence: 'auto-resolved: keyword match >50%',
          artifactSnippet: contentLower.slice(0, 120),
        };
        resolved++;
      }
    }
    if (resolved > 0) this._persist();
    return resolved;
  }

  exportReport() {
    const total = this._entries.length;
    const resolved = this._entries.filter(e => e.status === BS_STATUS.RESOLVED).length;
    const deferred = this._entries.filter(e => e.status === BS_STATUS.DEFERRED).length;
    const open = this._entries.filter(e => e.status === BS_STATUS.OPEN).length;
    return {
      totalBlindSpots: total, resolved, deferred, open,
      resolvedPercent: total > 0 ? Math.round(resolved / total * 100) : 100,
      details: this._entries.map(e => ({ id: e.id, stage: e.stage, severity: e.severity, status: e.status, dimension: e.dimension, evidence: e.evidence })),
    };
  }

  cleanup(maxAgeDays = 7) {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    const before = this._entries.length;
    this._entries = this._entries.filter(e =>
      e.status !== BS_STATUS.RESOLVED || new Date(e.detectedAt).getTime() > cutoff
    );
    if (this._entries.length < before) this._persist();
    return before - this._entries.length;
  }

  _load() {
    try {
      if (fs.existsSync(this._filePath)) {
        const raw = fs.readFileSync(this._filePath, 'utf8');
        this._entries = JSON.parse(raw);
        if (!Array.isArray(this._entries)) this._entries = [];
      }
    } catch (err) {
      console.error(`[BlindSpotRegistry] ⚠️ Registry file corrupt, rebuilding: ${err.message}`);
      this._entries = [];
    }
  }

  _persist() {
    const dir = path.dirname(this._filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._filePath, JSON.stringify(this._entries, null, 2), 'utf8');
  }

  _inferDimension(evidence) {
    const s = String(evidence || '');
    if (/\b边界|边界条件|edge.?case|boundary/i.test(s)) return 'BOUNDARY';
    if (/\b证据|支撑|evidence|proof/i.test(s)) return 'EVIDENCE';
    if (/\b逻辑|矛盾|logic|contradict/i.test(s)) return 'LOGIC';
    if (/\b深度|细节|depth|detail/i.test(s)) return 'DEPTH';
    if (/\b精确|量化|precision|quantif/i.test(s)) return 'PRECISION';
    if (/\b清晰|模糊|clarit|ambiguous/i.test(s)) return 'CLARITY';
    if (/\b权衡|备选|trade.?off|alternative/i.test(s)) return 'RELEVANCE';
    if (/\b影响范围|breadth|scope/i.test(s)) return 'BREADTH';
    if (/\b数据|data|metric/i.test(s)) return 'DATA';
    if (/\b收益|roi|cost.?benefit/i.test(s)) return 'ROI_ASSESSMENT';
    if (/\b第一性|first.?principle|fundamental/i.test(s)) return 'FIRST_PRINCIPLES';
    const dimMatch = s.match(/\[([A-Z_]+)\]/);
    return dimMatch && DIMENSION_SEVERITY_MAP[dimMatch[1]] ? dimMatch[1] : 'CLARITY';
  }

  _extractKeywords(evidence) {
    return String(evidence || '')
      .replace(/⚠️/g, '')
      .replace(/\[BLIND SPOT\]/gi, '')
      .replace(/\[[A-Z_]+\]/g, '')
      .replace(/[—,。""''()（）]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !/^(the|a|an|is|are|of|for|and|or|in|on|at|to|by|缺失|需要|补充|严重|薄弱|维度)$/.test(w));
  }
}

BlindSpotRegistry.BS_STATUS = BS_STATUS;
BlindSpotRegistry.DIMENSION_SEVERITY_MAP = DIMENSION_SEVERITY_MAP;
BlindSpotRegistry.STAGE_VERIFICATION_MAP = STAGE_VERIFICATION_MAP;

module.exports = BlindSpotRegistry;
