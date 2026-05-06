'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODE_ENV = 'PROMPT_CONTEXT_ASSEMBLER_MODE';
const MODES = Object.freeze({
  RUNTIME: 'runtime',
  DUAL_WRITE_CANARY: 'dual-write-canary',
  CANDIDATE_RUNTIME: 'candidate-runtime',
});
const VALID_MODES = new Set(Object.values(MODES));

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizePromptPayload(prompt) {
  if (Array.isArray(prompt)) {
    return prompt.map(item => (item && typeof item === 'object' ? String(item.content || '') : String(item || ''))).join('\n');
  }
  return String(prompt || '');
}

function resolvePromptContextAssemblerMode(env = process.env) {
  const raw = String(env[MODE_ENV] || MODES.CANDIDATE_RUNTIME).trim().toLowerCase();
  const mode = VALID_MODES.has(raw) ? raw : MODES.CANDIDATE_RUNTIME;
  return {
    envName: MODE_ENV,
    raw,
    mode,
    valid: VALID_MODES.has(raw),
    changedPromptOutput: mode === MODES.CANDIDATE_RUNTIME,
    shouldBuildCandidate: mode !== MODES.RUNTIME,
    shouldSendCandidate: mode === MODES.CANDIDATE_RUNTIME,
    shouldRecordCanary: mode === MODES.DUAL_WRITE_CANARY,
    defaultMode: `${MODE_ENV}=${MODES.CANDIDATE_RUNTIME}`,
    rollbackMode: `${MODE_ENV}=${MODES.RUNTIME}`,
    safeDefault: `${MODE_ENV}=${MODES.CANDIDATE_RUNTIME}`,
  };
}

function appendRuntimeModeCanary({ outputDir, role, stage, mode, runtimePrompt, candidatePrompt, candidateMeta = {}, routeMeta = null }) {
  if (!outputDir) return null;
  const runtimeText = normalizePromptPayload(runtimePrompt);
  const candidateText = normalizePromptPayload(candidatePrompt);
  const entry = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode,
    changedPromptOutput: false,
    role,
    stage: stage || null,
    runtime: {
      hash: sha256(runtimeText),
      length: runtimeText.length,
    },
    candidate: {
      hash: sha256(candidateText),
      length: candidateText.length,
      estimatedTokens: candidateMeta.estimatedTokens || 0,
      injectedSkillNames: candidateMeta.injectedSkillNames || [],
    },
    routeMeta,
  };
  const target = path.join(outputDir, 'prompt-context-runtime-mode-canary.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf-8');
  return { path: target, entry };
}

module.exports = {
  MODE_ENV,
  MODES,
  resolvePromptContextAssemblerMode,
  normalizePromptPayload,
  appendRuntimeModeCanary,
};
