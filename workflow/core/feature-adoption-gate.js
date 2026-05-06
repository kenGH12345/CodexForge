'use strict';

const fs = require('fs');
const path = require('path');

function _asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function _readIfExists(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  } catch (_) {
    return '';
  }
}

function _resolve(projectRoot, relOrAbs) {
  return path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(projectRoot, relOrAbs);
}

function _contains(text, pattern) {
  if (pattern instanceof RegExp) return pattern.test(text);
  const s = String(pattern || '');
  if (s.startsWith('/') && s.endsWith('/')) {
    try { return new RegExp(s.slice(1, -1)).test(text); } catch (_) { return text.includes(s); }
  }
  return text.includes(s);
}

function _termPresent(text, term) {
  return String(text || '').toLowerCase().includes(String(term || '').toLowerCase());
}

function _parseYamlName(skillMarkdown) {
  const match = String(skillMarkdown || '').match(/^---[\s\S]*?^name:\s*['"]?([^'"\r\n]+)['"]?/m);
  return match ? match[1].trim() : null;
}

function _collectSkillText(skillDir) {
  const skillPath = path.join(skillDir, 'SKILL.md');
  const parts = [_readIfExists(skillPath)];
  const refDir = path.join(skillDir, 'references');
  if (fs.existsSync(refDir)) {
    for (const name of fs.readdirSync(refDir).filter(f => f.endsWith('.md')).sort()) {
      parts.push(_readIfExists(path.join(refDir, name)));
    }
  }
  return {
    skillPath,
    text: parts.join('\n'),
    referenceCount: fs.existsSync(refDir) ? fs.readdirSync(refDir).filter(f => f.endsWith('.md')).length : 0,
  };
}

function evaluateFeatureAdoption(projectRoot, proof = {}) {
  const checks = [];
  let passed = true;

  for (const item of _asArray(proof.mustUse)) {
    const rule = typeof item === 'string' ? { file: item } : item;
    const full = _resolve(projectRoot, rule.file || '');
    const content = _readIfExists(full);
    let ok = !!content;
    if (rule.contains) ok = ok && _asArray(rule.contains).every(p => _contains(content, p));
    if (rule.notContains) ok = ok && _asArray(rule.notContains).every(p => !_contains(content, p));
    if (!ok) passed = false;
    checks.push({ type: 'featureAdoption.mustUse', file: rule.file, passed: ok, contains: rule.contains || null });
  }

  for (const item of _asArray(proof.mustAppearInOutput)) {
    const rule = typeof item === 'string' ? { term: item, files: ['output/test-report.md'] } : item;
    const files = _asArray(rule.files || rule.file || ['output/test-report.md']);
    const combined = files.map(f => _readIfExists(_resolve(projectRoot, f))).join('\n');
    const terms = _asArray(rule.terms || rule.term || rule.contains);
    const ok = terms.length > 0 && terms.every(t => _termPresent(combined, t));
    if (!ok) passed = false;
    checks.push({ type: 'featureAdoption.mustAppearInOutput', files, terms, passed: ok });
  }

  for (const consumer of _asArray(proof.downstreamConsumers || proof.consumers)) {
    const name = consumer.name || 'unknown-consumer';
    const evidence = _asArray(consumer.evidence || consumer.files || []);
    const ok = evidence.length > 0 && evidence.every(e => fs.existsSync(_resolve(projectRoot, e.file || e)));
    if (!ok) passed = false;
    checks.push({ type: 'downstreamConsumer', name, evidence, passed: ok });
  }

  return { passed, checks };
}

function evaluateSkillQuality(projectRoot, config = {}) {
  const checks = [];
  let passed = true;
  const skillDir = _resolve(projectRoot, config.skillDir || '.workflow/skills');
  const targetDir = fs.existsSync(path.join(skillDir, 'SKILL.md'))
    ? skillDir
    : fs.existsSync(skillDir)
      ? fs.readdirSync(skillDir).map(n => path.join(skillDir, n)).find(d => fs.existsSync(path.join(d, 'SKILL.md')))
      : null;

  if (!targetDir) {
    return { passed: false, checks: [{ type: 'semanticQuality.skillDir', passed: false, message: 'No SKILL.md found' }] };
  }

  const collected = _collectSkillText(targetDir);
  const skillMarkdown = _readIfExists(collected.skillPath);
  const skillName = _parseYamlName(skillMarkdown);
  const allText = collected.text;

  for (const bad of _asArray(config.forbiddenSkillNames)) {
    const ok = String(skillName || '').toLowerCase() !== String(bad).toLowerCase();
    if (!ok) passed = false;
    checks.push({ type: 'semanticQuality.forbiddenSkillName', skillName, forbidden: bad, passed: ok });
  }

  for (const term of _asArray(config.requiredTerms)) {
    const ok = _termPresent(allText, term);
    if (!ok) passed = false;
    checks.push({ type: 'semanticQuality.requiredTerm', term, passed: ok });
  }

  for (const pattern of _asArray(config.forbiddenEntryPatterns || config.forbiddenPatterns)) {
    const ok = !_contains(allText, pattern);
    if (!ok) passed = false;
    checks.push({ type: 'semanticQuality.forbiddenPattern', pattern, passed: ok });
  }

  if (config.minReferenceFiles !== undefined) {
    const ok = collected.referenceCount >= Number(config.minReferenceFiles);
    if (!ok) passed = false;
    checks.push({ type: 'semanticQuality.minReferenceFiles', actual: collected.referenceCount, expected: Number(config.minReferenceFiles), passed: ok });
  }

  const fallbackDetected = /fallback mode|llmPowered:\s*false|fallback-sharded/i.test(allText);
  if (config.forbidFallback === true || config.largeProjectRequiresReasonedSkill === true) {
    const ok = !fallbackDetected;
    if (!ok) passed = false;
    checks.push({ type: 'fallbackPolicy.forbidFallback', fallbackDetected, passed: ok });
  }

  return { passed, skillDir: targetDir, skillName, checks };
}

function scoreSkillText(text, rubric = {}) {
  const requiredTerms = _asArray(rubric.requiredTerms);
  const forbiddenPatterns = _asArray(rubric.forbiddenPatterns || rubric.forbiddenEntryPatterns);
  let score = 0;
  let max = 0;

  for (const term of requiredTerms) {
    max += 1;
    if (_termPresent(text, term)) score += 1;
  }
  for (const pattern of forbiddenPatterns) {
    max += 1;
    if (!_contains(text, pattern)) score += 1;
  }
  if (rubric.minReferenceFiles !== undefined) max += 1;
  return { score, max, ratio: max === 0 ? 1 : score / max };
}

function evaluateSkillRegression(projectRoot, config = {}) {
  const newDir = _resolve(projectRoot, config.newSkillDir || config.skillDir || '.workflow/skills');
  const oldDir = config.oldSkillDir ? _resolve(projectRoot, config.oldSkillDir) : null;
  if (!oldDir) return { passed: true, skipped: true, checks: [] };

  const newText = _collectSkillText(newDir).text;
  const oldText = _collectSkillText(oldDir).text;
  if (!newText || !oldText) {
    return { passed: false, checks: [{ type: 'semanticRegression.inputs', passed: false, message: 'old/new skill text missing' }] };
  }

  const rubric = config.rubric || config;
  const newScore = scoreSkillText(newText, rubric);
  const oldScore = scoreSkillText(oldText, rubric);
  const minRatio = Number(config.minRatio || 0.8);
  const relative = oldScore.ratio === 0 ? 1 : newScore.ratio / oldScore.ratio;
  const passed = relative >= minRatio;
  return {
    passed,
    checks: [{ type: 'semanticRegression.oldVsNew', passed, newScore, oldScore, relative, minRatio }],
  };
}

function evaluateCompletionMechanisms(projectRoot, contract = {}) {
  const checks = [];
  let passed = true;

  if (contract.featureAdoption || contract.downstreamConsumers) {
    const adoption = evaluateFeatureAdoption(projectRoot, {
      ...(contract.featureAdoption || {}),
      downstreamConsumers: contract.downstreamConsumers || (contract.featureAdoption || {}).downstreamConsumers,
    });
    if (!adoption.passed) passed = false;
    checks.push(...adoption.checks);
  }

  if (contract.semanticQuality || contract.fallbackPolicy) {
    const quality = evaluateSkillQuality(projectRoot, {
      ...(contract.semanticQuality || {}),
      ...(contract.fallbackPolicy || {}),
    });
    if (!quality.passed) passed = false;
    checks.push(...quality.checks);
  }

  if (contract.semanticRegression || contract.oldVsNewRegression) {
    const regression = evaluateSkillRegression(projectRoot, contract.semanticRegression || contract.oldVsNewRegression);
    if (!regression.passed) passed = false;
    checks.push(...regression.checks);
  }

  return { passed, checks };
}

module.exports = {
  evaluateFeatureAdoption,
  evaluateSkillQuality,
  evaluateSkillRegression,
  evaluateCompletionMechanisms,
  scoreSkillText,
};
