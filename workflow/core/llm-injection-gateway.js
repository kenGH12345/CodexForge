'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODE_ENV = 'WF_LLM_INJECTION_GATEWAY_MODE';
const CANARY_APPROVED_ENV = 'WF_LLM_INJECTION_CANARY_APPROVED';
const CANARY_ALLOWLIST_ENV = 'WF_LLM_INJECTION_CANARY_ALLOWLIST';
const CANARY_PERCENT_ENV = 'WF_LLM_INJECTION_CANARY_PERCENT';
const CANARY_ROLLBACK_ENV = 'WF_LLM_INJECTION_CANARY_ROLLBACK';
const MODES = Object.freeze({
  OFF: 'off',
  SHADOW: 'shadow',
  CANDIDATE_RUNTIME: 'candidate-runtime',
});
const VALID_MODES = new Set(Object.values(MODES));

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function stableStringify(value, seen = new WeakSet()) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'function') return `[Function:${value.name || 'anonymous'}]`;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item, seen)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key], seen)}`).join(',')}}`;
}

function normalizePromptPayload(payload) {
  return stableStringify(payload);
}

function resolveGatewayMode(env = process.env) {
  const raw = String(env[MODE_ENV] || MODES.CANDIDATE_RUNTIME).trim().toLowerCase();
  const mode = VALID_MODES.has(raw) ? raw : MODES.CANDIDATE_RUNTIME;
  return {
    envName: MODE_ENV,
    raw,
    mode,
    valid: VALID_MODES.has(raw),
    changedPromptOutput: mode === MODES.CANDIDATE_RUNTIME,
    shouldRecordShadow: mode === MODES.SHADOW || mode === MODES.CANDIDATE_RUNTIME,
    shouldSendCandidate: mode === MODES.CANDIDATE_RUNTIME,
    defaultMode: `${MODE_ENV}=${MODES.CANDIDATE_RUNTIME}`,
    rollbackMode: `${MODE_ENV}=${MODES.SHADOW}`,
    safeDefault: `${MODE_ENV}=${MODES.CANDIDATE_RUNTIME}`,
  };
}

function isTruthy(value) {
  return /^(1|true|yes|approved|on)$/i.test(String(value || '').trim());
}

function parseAllowlist(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function matchesAllowlist(callSite, allowlist) {
  if (!allowlist.length) return false;
  const site = String(callSite || '');
  return allowlist.some(pattern => {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) return site.startsWith(pattern.slice(0, -1));
    return site === pattern;
  });
}

function stablePercentBucket(callSite) {
  const hex = sha256(callSite || 'unknown').slice(0, 8);
  return parseInt(hex, 16) % 100;
}

function resolveCanaryDecision({ env = process.env, callSite = 'unknown', metadata = {}, modeInfo = null } = {}) {
  const mode = modeInfo || resolveGatewayMode(env);
  const hasApprovalOverride = Object.prototype.hasOwnProperty.call(env, CANARY_APPROVED_ENV);
  const approved = hasApprovalOverride ? isTruthy(env[CANARY_APPROVED_ENV]) : true;
  const rollback = isTruthy(env[CANARY_ROLLBACK_ENV]);
  const allowlist = parseAllowlist(env[CANARY_ALLOWLIST_ENV]);
  const percent = Math.max(0, Math.min(100, Number(env[CANARY_PERCENT_ENV] || 100)));
  const category = String(metadata.category || '');
  const governedCategory = /^(agent-wrapper|agent-adapter-call|raw-orchestrator-call|direct-chat-api|external-provider-call|llm-lite-call|injected-llm-call|verification)$/i.test(category);
  const allowlistMatched = allowlist.length === 0 ? true : matchesAllowlist(callSite, allowlist);
  const bucket = stablePercentBucket(callSite);
  const percentMatched = percent > 0 && bucket < percent;
  const reasons = [];
  if (mode.mode !== MODES.CANDIDATE_RUNTIME) reasons.push('mode-not-candidate-runtime');
  if (!approved) reasons.push('manual-approval-missing');
  if (rollback) reasons.push('rollback-active');
  if (!allowlistMatched) reasons.push('allowlist-miss');
  if (!percentMatched) reasons.push('percent-miss');
  if (!governedCategory) reasons.push('not-governed-category');
  const allowed = mode.mode === MODES.CANDIDATE_RUNTIME && approved && !rollback && allowlistMatched && percentMatched && governedCategory;
  return {
    allowed,
    approved,
    rollback,
    allowlistMatched,
    percent,
    bucket,
    percentMatched,
    lowRiskCategory: governedCategory,
    governedCategory,
    defaultReplacement: !hasApprovalOverride && allowlist.length === 0 && percent === 100,
    reasons: allowed ? [] : reasons,
  };
}

function sanitizeMetadata(metadata = {}) {
  const allowed = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (/key|token|secret|authorization|password|prompt|content/i.test(key)) continue;
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      allowed[key] = value;
    } else if (Array.isArray(value)) {
      allowed[key] = value.map(item => String(item)).slice(0, 20);
    } else {
      allowed[key] = String(value).slice(0, 200);
    }
  }
  return allowed;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeStatus(value, fallback = 'prepared') {
  const status = String(value || fallback).trim().toLowerCase();
  return /^[a-z0-9_-]{1,40}$/.test(status) ? status : fallback;
}

function computeQualityDriftScore(runtimeLength, candidateLength, explicit) {
  const explicitScore = finiteNumber(explicit);
  if (explicitScore != null) return Math.abs(explicitScore);
  if (!runtimeLength || runtimeLength <= 0) return 0;
  return Math.abs(Number(candidateLength || 0) - Number(runtimeLength || 0)) / runtimeLength;
}

function applyTelemetry(record, telemetry = {}) {
  record.status = safeStatus(telemetry.status, record.status || 'prepared');
  const runtimeLatencyMs = finiteNumber(telemetry.runtimeLatencyMs ?? telemetry.latencyMs);
  const candidateLatencyMs = finiteNumber(telemetry.candidateLatencyMs ?? telemetry.latencyMs);
  if (runtimeLatencyMs != null) record.runtime.latencyMs = Math.max(0, runtimeLatencyMs);
  if (candidateLatencyMs != null) record.candidate.latencyMs = Math.max(0, candidateLatencyMs);
  record.qualityDriftScore = computeQualityDriftScore(record.runtime.length, record.candidate.length, telemetry.qualityDriftScore ?? record.qualityDriftScore);
  return record;
}

function resolveGatewayFromOwner(owner, options = {}) {
  if (options.gateway) return options.gateway;
  if (owner && owner.llmInjectionGateway) return owner.llmInjectionGateway;
  if (owner && owner._orch && owner._orch.llmInjectionGateway) return owner._orch.llmInjectionGateway;
  return new LLMInjectionGateway({ outputDir: options.outputDir || owner?._outputDir || owner?.outputDir || owner?._orch?._outputDir || null });
}

function prepareGatewayPrompt(owner, options = {}) {
  try {
    return resolveGatewayFromOwner(owner, options).prepare(options).promptToSend;
  } catch (_) {
    return Object.prototype.hasOwnProperty.call(options, 'runtimePrompt') ? options.runtimePrompt : options.prompt;
  }
}

class LLMInjectionGateway {
  constructor(options = {}) {
    this.outputDir = options.outputDir || null;
    this.env = options.env || process.env;
    this.modeOverride = options.mode || null;
    this.artifactName = options.artifactName || 'unified-llm-injection-shadow.jsonl';
  }

  resolveMode() {
    if (!this.modeOverride) return resolveGatewayMode(this.env);
    return resolveGatewayMode({ [MODE_ENV]: this.modeOverride });
  }

  prepare(options = {}) {
    const modeInfo = this.resolveMode();
    const runtimePrompt = Object.prototype.hasOwnProperty.call(options, 'runtimePrompt') ? options.runtimePrompt : options.prompt;
    const candidatePrompt = Object.prototype.hasOwnProperty.call(options, 'candidatePrompt') ? options.candidatePrompt : runtimePrompt;
    const callSite = options.callSite || 'unknown';
    const canary = resolveCanaryDecision({ env: this.env, callSite, metadata: options.metadata || {}, modeInfo });
    const shouldSendCandidate = modeInfo.shouldSendCandidate && canary.allowed;
    const promptToSend = shouldSendCandidate ? candidatePrompt : runtimePrompt;
    const runtimeText = normalizePromptPayload(runtimePrompt);
    const candidateText = normalizePromptPayload(candidatePrompt);
    const record = applyTelemetry({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: modeInfo.mode,
      changedPromptOutput: shouldSendCandidate,
      callSite,
      role: options.role || null,
      stage: options.stage || null,
      runtime: {
        hash: sha256(runtimeText),
        length: runtimeText.length,
      },
      candidate: {
        hash: sha256(candidateText),
        length: candidateText.length,
      },
      metadata: sanitizeMetadata(options.metadata || {}),
      canary: {
        allowed: canary.allowed,
        approved: canary.approved,
        rollback: canary.rollback,
        allowlistMatched: canary.allowlistMatched,
        percent: canary.percent,
        bucket: canary.bucket,
        percentMatched: canary.percentMatched,
        lowRiskCategory: canary.lowRiskCategory,
        governedCategory: canary.governedCategory,
        defaultReplacement: canary.defaultReplacement,
        reasons: canary.reasons,
      },
    }, options.telemetry || {});
    const shouldAppend = modeInfo.shouldRecordShadow && options.deferAppend !== true;
    if (shouldAppend) {
      this._append(record);
    }
    let outcomeRecorded = shouldAppend;
    const recordOutcome = (telemetry = {}) => {
      applyTelemetry(record, telemetry);
      if (modeInfo.shouldRecordShadow && !outcomeRecorded) {
        this._append(record);
        outcomeRecorded = true;
      }
      return record;
    };
    return {
      promptToSend,
      candidatePrompt,
      mode: modeInfo.mode,
      changedPromptOutput: shouldSendCandidate,
      canary,
      record,
      recordOutcome,
    };
  }

  _append(record) {
    if (!this.outputDir) return;
    try {
      const target = path.join(this.outputDir, this.artifactName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf-8');
    } catch (err) {
      record.telemetryError = err.message;
    }
  }
}

module.exports = {
  MODE_ENV,
  CANARY_APPROVED_ENV,
  CANARY_ALLOWLIST_ENV,
  CANARY_PERCENT_ENV,
  CANARY_ROLLBACK_ENV,
  MODES,
  LLMInjectionGateway,
  resolveGatewayMode,
  resolveCanaryDecision,
  normalizePromptPayload,
  prepareGatewayPrompt,
};
