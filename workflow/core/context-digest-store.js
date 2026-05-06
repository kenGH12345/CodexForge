'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractMdSummary, extractDiffSummary } = require('./stage-output-reporter');

const DIGEST_VERSION = 1;
const STAGE_FILE_NAMES = {
  ANALYSE: 'analysis',
  ARCHITECT: 'architecture',
  PLAN: 'plan',
  DEVELOP: 'develop',
  CODE: 'develop',
  TEST: 'test',
  REVIEW: 'review',
  DEPLOY: 'deploy',
};
const STAGE_ORDER = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'];
const STAGE_REQUIRED_SKILLS = {
  ANALYSE: ['workflow-orchestration', 'problem-solving'],
  ARCHITECT: ['workflow-orchestration', 'architecture-design'],
  PLAN: ['workflow-orchestration', 'code-development'],
  DEVELOP: ['workflow-orchestration', 'javascript-dev'],
  TEST: ['workflow-orchestration', 'test-report'],
  REVIEW: ['workflow-orchestration', 'code-review'],
  DEPLOY: ['workflow-orchestration'],
};
const STAGE_FALLBACK_ARTIFACTS = {
  ANALYSE: ['output/context-digests/index.json', 'output/project-profile.md'],
  ARCHITECT: ['output/analysis.md', 'output/architecture-constraints.md'],
  PLAN: ['output/analysis.md', 'output/architecture.md'],
  DEVELOP: ['output/execution-plan.md', 'output/architecture.md'],
  TEST: ['output/execution-plan.md', 'output/code.diff'],
  REVIEW: ['output/test-report.md', 'output/code.diff'],
  DEPLOY: ['output/review-output.md', 'output/test-report.md'],
};
const STAGE_REQUIRED_COVERAGE = {
  ARCHITECT: ['hasRootCause', 'hasAffectedFiles', 'hasRisks'],
  PLAN: ['hasDecisions', 'hasRisks'],
  DEVELOP: ['hasTasks'],
  TEST: ['hasTasks', 'hasFilesChanged'],
  REVIEW: ['hasTestEvidence'],
  DEPLOY: ['hasTestEvidence'],
};

function digestDir(projectRoot) {
  return path.join(projectRoot || '.', 'output', 'context-digests');
}

function digestFileName(stage) {
  return `${(STAGE_FILE_NAMES[stage] || String(stage || 'unknown').toLowerCase())}.json`;
}

function digestPath(projectRoot, stage) {
  return path.join(digestDir(projectRoot), digestFileName(stage));
}

function indexPath(projectRoot) {
  return path.join(digestDir(projectRoot), 'index.json');
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function hashFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return sha256(fs.readFileSync(filePath));
}

function relPath(projectRoot, filePath) {
  const root = path.resolve(projectRoot || '.');
  const abs = path.resolve(filePath);
  return path.relative(root, abs).replace(/\\/g, '/');
}

function loadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function loadDigestIndex(projectRoot) {
  return loadJson(indexPath(projectRoot), { version: DIGEST_VERSION, updatedAt: null, digests: {} });
}

function _extractSection(content, headingPatterns) {
  if (!content) return [];
  const chunks = content.split(/(?=^##\s+)/m);
  for (const chunk of chunks) {
    const first = chunk.split('\n')[0] || '';
    if (headingPatterns.some(re => re.test(first))) {
      return chunk
        .split('\n')
        .slice(1)
        .map(l => l.trim())
        .filter(l => l && !/^\|[-\s|:]+\|$/.test(l))
        .slice(0, 12);
    }
  }
  return [];
}

function _extractFileRefs(content) {
  const refs = new Set();
  const re = /\b([\w.-]+(?:[\\/][\w.-]+)+\.(?:js|ts|jsx|tsx|json|md|yml|yaml|py|go|java|cs|cpp|h|lua|proto))\b/g;
  let m;
  while ((m = re.exec(content || '')) !== null) refs.add(m[1].replace(/\\/g, '/'));
  return [...refs].slice(0, 40);
}

function _extractKeywords(content) {
  const words = String(content || '')
    .match(/[A-Za-z_][A-Za-z0-9_]{2,}|[\u4e00-\u9fff]{2,}/g) || [];
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'output', 'stage', 'context', 'digest']);
  const counts = new Map();
  for (const w of words) {
    const k = w.toLowerCase();
    if (stop.has(k)) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).slice(0, 40);
}

function _mergeUnique(a, b, keyFn = x => JSON.stringify(x)) {
  const out = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (item == null) continue;
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function _buildContent(stage, artifactPath, content, stageOutputReport) {
  const isDiff = artifactPath.endsWith('.diff');
  const md = isDiff ? null : extractMdSummary(content, stage);
  const diff = isDiff ? extractDiffSummary(content) : null;
  const summary = md && md.keyPoints.length > 0
    ? md.keyPoints.slice(0, 3).join('; ')
    : (content.split(/\n{2,}/).find(p => p.trim().length > 40) || `${stage} stage completed`).trim().slice(0, 500);

  return {
    summary,
    outline: md ? md.outline.slice(0, 12) : [],
    keyPoints: md ? md.keyPoints.slice(0, 12) : [],
    rootCause: _extractSection(content, [/root\s*cause/i, /根因/]),
    decisions: _extractSection(content, [/decision/i, /决策|方案|选择/]),
    risks: _extractSection(content, [/risk/i, /风险/]),
    downstreamConsumers: _extractSection(content, [/downstream|consumer/i, /下游消费|下游消费者/]),
    tasks: _extractSection(content, [/^##\s*T-\d+/i, /task/i, /任务/]),
    acceptanceCriteria: _extractSection(content, [/acceptance|criteria/i, /验收|接受标准/]),
    testEvidence: _extractSection(content, [/test|verification|commands|results/i, /测试|验证|命令|结果/]),
    affectedFiles: _extractFileRefs(content),
    filesChanged: diff ? diff.filesChanged : [],
    stageOutputReport: stageOutputReport || null,
  };
}

function _mergeDigestContent(oldContent, newContent) {
  if (!oldContent) return newContent;
  return {
    summary: newContent.summary || oldContent.summary || '',
    outline: _mergeUnique(oldContent.outline, newContent.outline, x => x),
    keyPoints: _mergeUnique(oldContent.keyPoints, newContent.keyPoints, x => x),
    rootCause: _mergeUnique(oldContent.rootCause, newContent.rootCause, x => x),
    decisions: _mergeUnique(oldContent.decisions, newContent.decisions, x => x),
    risks: _mergeUnique(oldContent.risks, newContent.risks, x => x),
    downstreamConsumers: _mergeUnique(oldContent.downstreamConsumers, newContent.downstreamConsumers, x => x),
    tasks: _mergeUnique(oldContent.tasks, newContent.tasks, x => x),
    acceptanceCriteria: _mergeUnique(oldContent.acceptanceCriteria, newContent.acceptanceCriteria, x => x),
    testEvidence: _mergeUnique(oldContent.testEvidence, newContent.testEvidence, x => x),
    affectedFiles: _mergeUnique(oldContent.affectedFiles, newContent.affectedFiles, x => x),
    filesChanged: _mergeUnique(oldContent.filesChanged, newContent.filesChanged, x => x),
    stageOutputReport: newContent.stageOutputReport || oldContent.stageOutputReport || null,
  };
}

function _coverageForContent(content) {
  const c = content || {};
  return {
    hasSummary: !!c.summary,
    hasOutline: Array.isArray(c.outline) && c.outline.length > 0,
    hasKeyPoints: Array.isArray(c.keyPoints) && c.keyPoints.length > 0,
    hasRootCause: Array.isArray(c.rootCause) && c.rootCause.length > 0,
    hasDecisions: Array.isArray(c.decisions) && c.decisions.length > 0,
    hasRisks: Array.isArray(c.risks) && c.risks.length > 0,
    hasDownstreamConsumers: Array.isArray(c.downstreamConsumers) && c.downstreamConsumers.length > 0,
    hasTasks: Array.isArray(c.tasks) && c.tasks.length > 0,
    hasAcceptanceCriteria: Array.isArray(c.acceptanceCriteria) && c.acceptanceCriteria.length > 0,
    hasAffectedFiles: Array.isArray(c.affectedFiles) && c.affectedFiles.length > 0,
    hasFilesChanged: Array.isArray(c.filesChanged) && c.filesChanged.length > 0,
    hasTestEvidence: Array.isArray(c.testEvidence) && c.testEvidence.length > 0,
  };
}

function buildOrUpdateStageDigest(projectRoot, opts = {}) {
  const stage = String(opts.stage || '').toUpperCase();
  const artifactPath = opts.artifactPath;
  if (!stage || !artifactPath || !fs.existsSync(artifactPath)) {
    return { success: false, error: 'missing stage or artifactPath' };
  }
  const absArtifact = path.resolve(artifactPath);
  const sourceHash = hashFile(absArtifact);
  const outPath = digestPath(projectRoot, stage);
  const oldDigest = loadJson(outPath, null);
  if (oldDigest && oldDigest.source && oldDigest.source.sourceHash === sourceHash) {
    _updateIndex(projectRoot, oldDigest, outPath, 'fresh');
    return { success: true, reused: true, path: outPath, digest: oldDigest };
  }

  const raw = fs.readFileSync(absArtifact, 'utf-8');
  const content = _buildContent(stage, absArtifact, raw, opts.stageOutputReport);
  const files = _mergeUnique(content.affectedFiles, content.filesChanged, x => x);
  const digest = {
    version: DIGEST_VERSION,
    stage,
    source: {
      path: relPath(projectRoot, absArtifact),
      sourceHash,
      artifactSize: Buffer.byteLength(raw, 'utf-8'),
      updatedAt: fs.statSync(absArtifact).mtime.toISOString(),
    },
    scope: {
      session: opts.session || null,
      requirementFingerprint: opts.requirementFingerprint || _fingerprint(opts.requirement || ''),
    },
    content: _mergeDigestContent(oldDigest && oldDigest.content, content),
    coverage: null,
    evidenceRefs: files.map(file => ({ file, artifact: relPath(projectRoot, absArtifact) })).slice(0, 40),
    relevance: {
      keywords: _extractKeywords([opts.requirement || '', raw].join('\n')),
      files,
      modules: files.map(f => f.split('/')[0]).filter(Boolean).slice(0, 20),
    },
    generatedAt: new Date().toISOString(),
  };
  digest.coverage = _coverageForContent(digest.content);
  writeJsonAtomic(outPath, digest);
  _updateIndex(projectRoot, digest, outPath, 'fresh');
  return { success: true, reused: false, path: outPath, digest };
}

function _updateIndex(projectRoot, digest, outPath, status) {
  const index = loadDigestIndex(projectRoot);
  index.version = DIGEST_VERSION;
  index.updatedAt = new Date().toISOString();
  index.digests = index.digests || {};
  index.digests[digest.stage] = {
    path: relPath(projectRoot, outPath),
    source: digest.source.path,
    sourceHash: digest.source.sourceHash,
    status,
    updatedAt: digest.generatedAt || new Date().toISOString(),
    keywords: (digest.relevance && digest.relevance.keywords || []).slice(0, 20),
    files: (digest.relevance && digest.relevance.files || []).slice(0, 20),
    coverage: digest.coverage || {},
  };
  writeJsonAtomic(indexPath(projectRoot), index);
}

function _fingerprint(text) {
  return _extractKeywords(text).sort().slice(0, 30).join(' ');
}

function _isFresh(projectRoot, entry) {
  if (!entry || !entry.path || !entry.source || !entry.sourceHash) return false;
  const sourcePath = path.join(projectRoot, entry.source);
  return fs.existsSync(sourcePath) && hashFile(sourcePath) === entry.sourceHash;
}

function _scoreDigest(digest, stage, taskText) {
  const query = new Set(_extractKeywords(taskText));
  let overlapScore = 0;
  for (const k of (digest.relevance && digest.relevance.keywords || [])) {
    if (query.has(String(k).toLowerCase())) overlapScore += 3;
  }
  for (const f of (digest.relevance && digest.relevance.files || [])) {
    if (String(taskText).includes(f) || String(taskText).includes(path.basename(f))) overlapScore += 8;
  }

  // If a concrete task text exists, do not select a digest by stage proximity alone.
  // This enforces the user rule: unrelated context must remain stored but not injected.
  if (String(taskText || '').trim() && overlapScore <= 0) return 0;

  let score = overlapScore;
  const stageIdx = STAGE_ORDER.indexOf(stage);
  const digestIdx = STAGE_ORDER.indexOf(digest.stage);
  if (digestIdx >= 0 && stageIdx >= 0 && digestIdx < stageIdx) score += 20 - Math.min((stageIdx - digestIdx) * 3, 12);
  if (digest.content && digest.content.downstreamConsumers && digest.content.downstreamConsumers.length > 0) score += 4;
  return score;
}

function getRequiredSkillsForStage(stage) {
  return [...(STAGE_REQUIRED_SKILLS[String(stage || '').toUpperCase()] || ['workflow-orchestration'])];
}

function _buildSafety(stage, selected, skipped, opts = {}) {
  const minScore = Number.isFinite(Number(opts.minScore)) ? Number(opts.minScore) : 12;
  const highestScore = selected.length > 0 ? Math.max(...selected.map(d => d.relevanceScore || 0)) : 0;
  const requiredCoverage = STAGE_REQUIRED_COVERAGE[stage] || [];
  const missingCoverage = requiredCoverage.filter(flag => !selected.some(d => d.coverage && d.coverage[flag]));
  const lowConfidence = selected.length === 0 || highestScore < minScore;
  const fallbackArtifacts = (lowConfidence || missingCoverage.length > 0)
    ? [...(STAGE_FALLBACK_ARTIFACTS[stage] || [])]
    : [];
  return {
    minScore,
    highestScore,
    lowConfidence,
    missingCoverage,
    fallbackArtifacts,
    requiredSkills: getRequiredSkillsForStage(stage),
    skippedCount: Array.isArray(skipped) ? skipped.length : 0,
  };
}

function selectRelevantDigests(projectRoot, opts = {}) {
  const stage = String(opts.stage || '').toUpperCase();
  const taskText = opts.taskText || '';
  const maxItems = opts.maxItems || 3;
  const index = loadDigestIndex(projectRoot);
  const selected = [];
  const skipped = [];
  for (const [digestStage, entry] of Object.entries(index.digests || {})) {
    if (digestStage === stage) continue;
    if (!_isFresh(projectRoot, entry)) {
      skipped.push({ stage: digestStage, reason: 'stale' });
      continue;
    }
    const digest = loadJson(path.join(projectRoot, entry.path), null);
    if (!digest) {
      skipped.push({ stage: digestStage, reason: 'missing' });
      continue;
    }
    const score = _scoreDigest(digest, stage, taskText);
    if (score <= 0) {
      skipped.push({ stage: digestStage, reason: 'irrelevant', score });
      continue;
    }
    selected.push({ ...digest, relevanceScore: score });
  }
  selected.sort((a, b) => b.relevanceScore - a.relevanceScore);
  const finalSelected = selected.slice(0, maxItems);
  return {
    selected: finalSelected,
    skipped,
    safety: _buildSafety(stage, finalSelected, skipped, opts),
    indexPath: indexPath(projectRoot),
  };
}

function formatDigestBlock(digests, safety = null) {
  if ((!Array.isArray(digests) || digests.length === 0) && !safety) return '';
  const lines = [
    '## 🧠 Context Digests (reused, relevant only)',
    '> Fresh digest summaries are injected instead of full artifacts. Full files remain available via source refs.',
    '',
  ];
  for (const d of (Array.isArray(digests) ? digests : [])) {
    lines.push(`### ${d.stage} digest (score=${d.relevanceScore || 0})`);
    if (d.content && d.content.summary) lines.push(`- Summary: ${d.content.summary}`);
    for (const p of (d.content && d.content.keyPoints || []).slice(0, 4)) lines.push(`- ${p}`);
    if (d.content && d.content.downstreamConsumers && d.content.downstreamConsumers.length > 0) {
      lines.push('- Downstream:');
      for (const c of d.content.downstreamConsumers.slice(0, 4)) lines.push(`  - ${c}`);
    }
    const refs = (d.evidenceRefs || []).slice(0, 5).map(r => r.file).filter(Boolean);
    if (refs.length > 0) lines.push(`- Evidence refs: ${refs.map(r => `\`${r}\``).join(', ')}`);
    if (d.source && d.source.path) lines.push(`- Full source: \`${d.source.path}\` (${String(d.source.sourceHash || '').slice(0, 12)})`);
    lines.push('');
  }
  if (safety) {
    lines.push('### Safety Net');
    lines.push(`- Required skills: ${(safety.requiredSkills || []).map(s => `\`${s}\``).join(', ') || 'none'}`);
    lines.push(`- Confidence: highest=${safety.highestScore || 0}, min=${safety.minScore || 0}, low=${safety.lowConfidence ? 'yes' : 'no'}`);
    if ((safety.missingCoverage || []).length > 0) lines.push(`- Missing coverage: ${safety.missingCoverage.join(', ')}`);
    if ((safety.fallbackArtifacts || []).length > 0) lines.push(`- Fallback artifacts if needed: ${safety.fallbackArtifacts.map(f => `\`${f}\``).join(', ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

module.exports = {
  DIGEST_VERSION,
  buildOrUpdateStageDigest,
  selectRelevantDigests,
  formatDigestBlock,
  getRequiredSkillsForStage,
  loadDigestIndex,
  hashFile,
  _extractKeywords,
  _fingerprint,
};
