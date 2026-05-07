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

function splitMarkdownHeadingBlocks(content) {
  const lines = String(content || '').split(/\r?\n/);
  const blocks = [];
  let current = null;

  const pushIfSubstantive = (block) => {
    if (!block) return;
    const body = block.lines.slice(1).join('\n').trim();
    if (body.replace(/[\s|\-:]+/g, '').length < 20) return;
    blocks.push(block);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,4}\s+/.test(trimmed)) {
      pushIfSubstantive(current);
      current = { heading: trimmed.replace(/^#{1,4}\s+/, '').trim(), lines: [trimmed] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  pushIfSubstantive(current);
  return blocks.map(b => ({ heading: b.heading, content: b.lines.join('\n').trim() }));
}

function scanMarkdownSections({ collector, projectRoot, filePath, type, owner, idPrefix, stage = [], role = [], priority = 50, dedupePolicy = 'semantic-shadow' }) {
  const content = safeRead(filePath);
  if (!content) return;
  const sections = splitMarkdownHeadingBlocks(content);
  if (sections.length === 0) {
    collector.addBlock({
      id: `${idPrefix}.document`,
      type,
      owner,
      source: rel(projectRoot, filePath),
      sourcePath: filePath,
      stage,
      role,
      priority,
      dedupePolicy,
      content,
    });
    return;
  }
  sections.forEach((section, index) => {
    collector.addBlock({
      id: `${idPrefix}.section.${index + 1}.${section.heading}`,
      type,
      owner,
      source: `${rel(projectRoot, filePath)}#${section.heading}`,
      sourcePath: filePath,
      stage,
      role,
      priority,
      dedupePolicy,
      content: section.content,
    });
  });
}

function scanRolePrefixes({ collector, projectRoot, filePath }) {
  const source = safeRead(filePath);
  if (!source) return;
  const re = /(?:^|\n)\s*(['"]?[A-Za-z0-9_-]+['"]?)\s*:\s*`([\s\S]*?)`\s*,/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const role = match[1].replace(/['"]/g, '');
    const content = match[2].trim();
    if (!role || content.length < 40) continue;
    collector.addBlock({
      id: `prompt-agent-prefix.${role}`,
      type: 'role-prefix',
      owner: 'PromptBuilder',
      source: `${rel(projectRoot, filePath)}#${role}`,
      sourcePath: filePath,
      role: [role],
      priority: 95,
      dedupePolicy: 'allowRepeat',
      content,
    });
  }
}

function scanContextLoaderConfig({ collector, projectRoot, filePath }) {
  if (!fs.existsSync(filePath)) return;
  try {
    delete require.cache[require.resolve(filePath)];
    const cfg = require(filePath);
    const entries = [
      ['ROLE_MANDATORY_DOCS', cfg.ROLE_MANDATORY_DOCS, 'mandatory-doc-map', 85],
      ['ROLE_CONSTRAINT_SECTIONS', cfg.ROLE_CONSTRAINT_SECTIONS, 'constraint-section-map', 70],
      ['BUILTIN_SKILL_KEYWORDS', cfg.BUILTIN_SKILL_KEYWORDS, 'skill-keyword-map', 65],
      ['SKILL_ROLE_FILTER', cfg.SKILL_ROLE_FILTER, 'skill-role-filter', 65],
      ['RISK_SKILL_PACKS', cfg.RISK_SKILL_PACKS, 'risk-skill-pack', 70],
    ];
    for (const [name, value, type, priority] of entries) {
      if (!value) continue;
      collector.addBlock({
        id: `context-loader-config.${name}`,
        type,
        owner: 'ContextLoader',
        source: `${rel(projectRoot, filePath)}#${name}`,
        sourcePath: filePath,
        priority,
        dedupePolicy: 'exact',
        content: JSON.stringify(value, null, 2),
      });
    }
  } catch {
    const content = safeRead(filePath);
    if (content) collector.addBlock({
      id: 'context-loader-config.source',
      type: 'context-loader-config',
      owner: 'ContextLoader',
      source: rel(projectRoot, filePath),
      sourcePath: filePath,
      priority: 65,
      content,
    });
  }
}

function scanBridgeInstructionBlocks({ collector, projectRoot, filePath }) {
  const source = safeRead(filePath);
  if (!source) return;
  const patterns = [
    ['workflow-stage.baseInstructions', /const baseInstructions = \[([\s\S]*?)\n\s*\]\.filter\(Boolean\);/],
    ['workflow-stage.testInstructions', /TEST SUITE ALREADY EXECUTED([\s\S]*?)REQUIRED in test-report\.md/],
    ['stage-complete.visibleConclusion', /function _buildVisibleStageConclusion\([\s\S]*?\n}\n\nfunction _summarizeTestStageFailure/],
    ['session-summary.retrospectiveSignals', /function _extractRetrospectiveFromMarkdown\([\s\S]*?\n}\n\nfunction _readJsonlRecords/],
  ];
  for (const [id, re] of patterns) {
    const match = source.match(re);
    if (!match) continue;
    collector.addBlock({
      id,
      type: 'workflow-stage-instruction',
      owner: 'IDEWorkflowBridge',
      source: `${rel(projectRoot, filePath)}#${id}`,
      sourcePath: filePath,
      priority: id.includes('test') ? 90 : 80,
      dedupePolicy: 'allowRepeat',
      content: match[0],
    });
  }
}

function scanSkills({ collector, projectRoot }) {
  const dirs = [
    path.join(projectRoot, 'workflow', 'skills'),
    path.join(projectRoot, '.workflow', 'skills'),
  ];
  for (const dir of dirs) {
    const files = collectFiles(dir, (abs, name) => name.endsWith('.md') || name === 'SKILL.md');
    for (const filePath of files) {
      const name = path.basename(filePath, '.md');
      scanMarkdownSections({
        collector,
        projectRoot,
        filePath,
        type: 'skill',
        owner: 'ContextLoader',
        idPrefix: `skill.${name}`,
        priority: 75,
        dedupePolicy: 'semantic-shadow',
      });
    }
  }
}

function scanContextDigests({ collector, projectRoot }) {
  const dir = path.join(projectRoot, 'output', 'context-digests');
  const files = collectFiles(dir, (abs, name) => name.endsWith('.json'));
  for (const filePath of files) {
    const content = safeRead(filePath);
    if (!content) continue;
    let parsed = null;
    try { parsed = JSON.parse(content); } catch { parsed = null; }
    collector.addBlock({
      id: `context-digest.${path.basename(filePath, '.json')}`,
      type: 'stage-digest',
      owner: 'ContextDigestStore',
      source: rel(projectRoot, filePath),
      sourcePath: filePath,
      stage: parsed?.stage ? [parsed.stage] : [],
      priority: 70,
      dedupePolicy: 'exact',
      content,
    });
  }
}

function roleToStage(role) {
  const map = {
    analyst: 'ANALYSE',
    architect: 'ARCHITECT',
    planner: 'PLAN',
    developer: 'DEVELOP',
    tester: 'TEST',
    reviewer: 'REVIEW',
    'test-report': 'TEST',
    'coding-agent': 'DEVELOP',
  };
  return map[role] || null;
}

function resolveContextLoaderDocPath(projectRoot, docRelPath) {
  if (!docRelPath) return null;
  if (docRelPath.startsWith('output/')) return path.join(projectRoot, docRelPath);
  return path.join(projectRoot, 'workflow', docRelPath);
}

function scanContextLoaderMandatoryDocs({ collector, projectRoot, filePath }) {
  if (!fs.existsSync(filePath)) return;
  let cfg = null;
  try {
    delete require.cache[require.resolve(filePath)];
    cfg = require(filePath);
  } catch {
    return;
  }
  const docs = new Map();
  for (const [role, relPaths] of Object.entries(cfg.ROLE_MANDATORY_DOCS || {})) {
    for (const docRelPath of relPaths || []) {
      if (!docs.has(docRelPath)) docs.set(docRelPath, { roles: new Set(), stages: new Set() });
      docs.get(docRelPath).roles.add(role);
      const stage = roleToStage(role);
      if (stage) docs.get(docRelPath).stages.add(stage);
    }
  }

  for (const [docRelPath, meta] of docs.entries()) {
    const docPath = resolveContextLoaderDocPath(projectRoot, docRelPath);
    const content = safeRead(docPath);
    if (!content) continue;
    const basename = path.basename(docRelPath, path.extname(docRelPath));
    const type = docRelPath.startsWith('output/') ? 'context-loader-artifact' : 'context-loader-doc';
    const owner = 'ContextLoader';
    const idPrefix = `context-loader-${docRelPath.startsWith('output/') ? 'artifact' : 'doc'}.${basename}`;
    const role = [...meta.roles];
    const stage = [...meta.stages];
    collector.addBlock({
      id: `${idPrefix}.document`,
      type,
      owner,
      source: rel(projectRoot, docPath),
      sourcePath: docPath,
      stage,
      role,
      priority: docRelPath.startsWith('output/') ? 82 : 88,
      dedupePolicy: 'semantic-shadow',
      content,
    });
    scanMarkdownSections({
      collector,
      projectRoot,
      filePath: docPath,
      type,
      owner,
      idPrefix,
      stage,
      role,
      priority: docRelPath.startsWith('output/') ? 78 : 84,
      dedupePolicy: 'semantic-shadow',
    });
  }
}

function scanStaticSourceFiles({ collector, projectRoot }) {
  const files = [
    ['agent-prompt-template', 'workflow/core/agent-prompt-template.js', 'system-template', 'AgentGenerator', 95],
    ['prompt-builder', 'workflow/core/prompt-builder.js', 'prompt-assembly-source', 'PromptBuilder', 80],
    ['context-loader', 'workflow/core/context-loader.js', 'context-loader-source', 'ContextLoader', 75],
    ['token-budget', 'workflow/core/token-budget.js', 'budget-policy-source', 'TokenBudget', 70],
    ['adapter-telemetry', 'workflow/core/adapter-telemetry.js', 'telemetry-source', 'AdapterTelemetry', 65],
    ['agents-md', 'AGENTS.md', 'project-rule', 'AgentRuntime', 90],
    ['workflow-config', 'workflow.config.js', 'workflow-config', 'ConfigLoader', 70],
  ];

  for (const [idPrefix, relPath, type, owner, priority] of files) {
    const filePath = path.join(projectRoot, relPath);
    if (!fs.existsSync(filePath)) continue;
    if (idPrefix === 'agent-prompt-template' || idPrefix === 'agents-md') {
      scanMarkdownSections({ collector, projectRoot, filePath, type, owner, idPrefix, priority, dedupePolicy: 'semantic-shadow' });
    } else {
      const content = safeRead(filePath);
      collector.addBlock({
        id: `${idPrefix}.source`,
        type,
        owner,
        source: rel(projectRoot, filePath),
        sourcePath: filePath,
        priority,
        dedupePolicy: 'exact',
        content: content.slice(0, 12000),
      });
    }
  }

  scanRolePrefixes({ collector, projectRoot, filePath: path.join(projectRoot, 'workflow/core/prompt-agent-prefixes.js') });
  scanContextLoaderConfig({ collector, projectRoot, filePath: path.join(projectRoot, 'workflow/core/context-loader-config.js') });
  scanBridgeInstructionBlocks({ collector, projectRoot, filePath: path.join(projectRoot, 'workflow/tools/ide-workflow-bridge.js') });
}

function groupBy(blocks, key) {
  const groups = new Map();
  for (const block of blocks) {
    const value = block[key];
    if (!value) continue;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(block);
  }
  return [...groups.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([hash, items]) => ({
      hash,
      count: items.length,
      blocks: items.map(toDuplicateRef),
    }));
}

function toDuplicateRef(block) {
  return {
    id: block.id,
    type: block.type,
    owner: block.owner,
    source: block.source,
    charCount: block.charCount,
    tokenEstimate: block.tokenEstimate,
    preview: block.preview,
  };
}

function tokenSet(block) {
  const normalized = normalizeContent(block.preview || '');
  return new Set((normalized.match(/[a-z0-9_]{3,}|[\u4e00-\u9fff]{2,}/g) || []).slice(0, 120));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const item of a) if (b.has(item)) inter++;
  return inter / (a.size + b.size - inter);
}

function findNearDuplicates(blocks, threshold = 0.82, maxPairs = 30) {
  const candidates = blocks
    .filter(b => b.charCount >= 80)
    .map(b => ({ block: b, tokens: tokenSet(b) }));
  const pairs = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const score = jaccard(candidates[i].tokens, candidates[j].tokens);
      if (score >= threshold) {
        pairs.push({
          score: Number(score.toFixed(3)),
          blocks: [toDuplicateRef(candidates[i].block), toDuplicateRef(candidates[j].block)],
        });
      }
    }
  }
  return pairs.sort((a, b) => b.score - a.score).slice(0, maxPairs);
}

function buildDuplicateReport(blocks) {
  const exact = groupBy(blocks, 'contentHash');
  const normalized = groupBy(blocks, 'normalizedHash');
  const near = findNearDuplicates(blocks);
  const duplicateBlockIds = new Set();
  for (const group of [...exact, ...normalized]) {
    for (const block of group.blocks) duplicateBlockIds.add(block.id);
  }
  for (const pair of near) {
    for (const block of pair.blocks) duplicateBlockIds.add(block.id);
  }
  return {
    summary: {
      totalBlocks: blocks.length,
      exactDuplicateGroups: exact.length,
      normalizedDuplicateGroups: normalized.length,
      nearDuplicatePairs: near.length,
      duplicateBlockCount: duplicateBlockIds.size,
      potentialSavingsBlocks: Math.max(0, duplicateBlockIds.size - exact.length - normalized.length),
    },
    exactDuplicates: exact,
    normalizedDuplicates: normalized,
    nearDuplicateCandidates: near,
  };
}

function blockMapById(blocks) {
  return new Map((blocks || []).map(block => [block.id, block]));
}

function enrichDuplicateRef(ref, blockMap) {
  const full = blockMap.get(ref.id) || {};
  return {
    ...ref,
    priority: full.priority || 0,
    dedupePolicy: full.dedupePolicy || 'semantic-shadow',
    contentHash: full.contentHash || null,
    normalizedHash: full.normalizedHash || null,
  };
}

function headingFromSource(source) {
  const fragment = String(source || '').split('#')[1] || '';
  return fragment.trim();
}

function hasTemplateScaffold(refs) {
  return refs.some(ref => /<!--\s*PURPOSE:/i.test(ref.preview || ''));
}

function isEvolutionHistory(refs) {
  return refs.every(ref => /#Evolution History$/i.test(ref.source || '') || /^Evolution History$/i.test(headingFromSource(ref.source)));
}

function isGeneratedProjectStandardsMirror(refs) {
  const sources = refs.map(ref => String(ref.source || ''));
  return sources.some(src => src.includes('.workflow/skills/project-standards.md'))
    && sources.some(src => src.includes('.workflow/skills/project-standards-knowledge.md'));
}

function skillNameFromSource(source) {
  const match = String(source || '').match(/(?:^|\/)skills\/([^/#]+)\.md#/);
  return match ? match[1] : '';
}

function isDomainSpecificProjectStructureRepeat(refs) {
  if (!Array.isArray(refs) || refs.length < 3) return false;
  const allStandardStructure = refs.every(ref => /^Standard Project Structure$/i.test(headingFromSource(ref.source)));
  if (!allStandardStructure) return false;

  const skillNames = new Set(refs.map(ref => skillNameFromSource(ref.source)).filter(Boolean));
  if (skillNames.size < 3) return false;

  const knownDomainStructureSkills = new Set([
    'android-dev',
    'flutter-dev',
    'ios-dev',
    'game-architecture',
    'game-ai-patterns',
  ]);
  const allKnownDomainSkills = [...skillNames].every(name => knownDomainStructureSkills.has(name));
  const treeLike = refs.every(ref => /```[\s\S]*(?:project-root|game-project)[\s\S]*(?:├|└)/.test(ref.preview || ''));
  return allKnownDomainSkills && treeLike;
}

function pickCanonicalBlock(refs) {
  return [...refs].sort((a, b) => {
    if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
    if ((b.charCount || 0) !== (a.charCount || 0)) return (b.charCount || 0) - (a.charCount || 0);
    return String(a.id).localeCompare(String(b.id));
  })[0];
}

function estimateTokenSavings(refs, canonical) {
  return refs
    .filter(ref => ref.id !== canonical.id)
    .reduce((sum, ref) => sum + Number(ref.tokenEstimate || 0), 0);
}

function classifyDuplicateEntry(entry, kind, blockMap) {
  const refs = (entry.blocks || []).map(ref => enrichDuplicateRef(ref, blockMap));
  const policies = new Set(refs.map(ref => ref.dedupePolicy));
  if (hasTemplateScaffold(refs) || isEvolutionHistory(refs)) {
    return {
      classification: 'template-noise',
      action: 'allowlist',
      confidence: 0.95,
      reason: '重复内容来自 skill 模板说明、占位结构或演进历史，属于报告噪声；应先过滤或 allowlist，而不是合并业务内容。',
      refs,
    };
  }
  if (isGeneratedProjectStandardsMirror(refs) || policies.has('allowRepeat')) {
    return {
      classification: 'reasonable-repeat',
      action: 'allowlist',
      confidence: 0.9,
      reason: '重复内容来自生成镜像、运行时固定前缀或显式 allowRepeat 策略，短期内保留重复更安全。',
      refs,
    };
  }
  if (isDomainSpecificProjectStructureRepeat(refs)) {
    return {
      classification: 'domain-specific-repeat',
      action: 'allowlist',
      confidence: 0.92,
      reason: '重复内容来自同名项目结构段落和树形目录格式，但各 block 表达 Android、Flutter、iOS、Game ECS、Game AI 等不同领域结构，应保留为 domain-specific project structure，而不是抽取共享模板。',
      refs,
    };
  }
  const exactLike = kind === 'exact' || kind === 'normalized' || Number(entry.score || 0) >= 0.97;
  return {
    classification: exactLike ? 'true-duplicate' : 'reasonable-repeat',
    action: exactLike ? 'merge-suggestion' : 'allowlist',
    confidence: exactLike ? 0.86 : 0.72,
    reason: exactLike
      ? '内容在语义或文本层面高度一致，且未命中模板噪声/合理重复规则，可生成合并建议。'
      : '近似重复但未达到安全自动合并阈值，应先作为合理重复保留并人工复核。',
    refs,
  };
}

function governanceEntryId(kind, entry, index) {
  const base = entry.hash ? entry.hash.slice(0, 12) : sha256((entry.blocks || []).map(b => b.id).join('|')).slice(0, 12);
  return `${kind}.${base}.${index + 1}`;
}

function buildMergeSuggestion(id, kind, entry, decision) {
  const canonical = pickCanonicalBlock(decision.refs);
  const duplicates = decision.refs.filter(ref => ref.id !== canonical.id);
  return {
    id: `merge.${id}`,
    classification: decision.classification,
    groupKind: kind,
    confidence: decision.confidence,
    canonicalBlock: canonical,
    duplicateBlocks: duplicates,
    estimatedTokenSavings: estimateTokenSavings(decision.refs, canonical),
    rationale: decision.reason,
    executableSteps: [
      `人工确认 ${canonical.source || canonical.id} 是否应作为 source-of-truth。`,
      '将 duplicateBlocks 中重复的通用内容抽取到共享 skill section 或删除空洞模板正文。',
      '重新运行 prompt-context-governance，确认 changedPromptOutput=false 且该 group 不再出现在 true-duplicate suggestions 中。',
    ],
    safety: '该建议只描述可执行合并步骤，不会自动修改任何 prompt、skill 或 runtime 输出。',
  };
}

function buildPromptContextDuplicateGovernance({ inventory, duplicateReport }) {
  const blockMap = blockMapById(inventory?.blocks || []);
  const entries = [];
  const mergeSuggestions = [];
  const allowlistEntries = [];
  const byClassification = {};
  const sources = [
    ['exact', duplicateReport?.exactDuplicates || []],
    ['normalized', duplicateReport?.normalizedDuplicates || []],
    ['near', duplicateReport?.nearDuplicateCandidates || []],
  ];

  for (const [kind, groups] of sources) {
    groups.forEach((entry, index) => {
      const id = governanceEntryId(kind, entry, index);
      const decision = classifyDuplicateEntry(entry, kind, blockMap);
      const record = {
        id,
        groupKind: kind,
        hash: entry.hash || null,
        score: entry.score || null,
        classification: decision.classification,
        action: decision.action,
        confidence: decision.confidence,
        reason: decision.reason,
        blockIds: decision.refs.map(ref => ref.id),
        sources: decision.refs.map(ref => ref.source).filter(Boolean),
      };
      entries.push(record);
      byClassification[decision.classification] = (byClassification[decision.classification] || 0) + 1;
      if (decision.action === 'allowlist') {
        allowlistEntries.push({
          id: `allow.${id}`,
          classification: decision.classification,
          match: {
            groupKind: kind,
            hash: entry.hash || null,
            blockIds: record.blockIds,
          },
          reason: decision.reason,
          owner: 'PromptContextGovernance',
          expiresAt: null,
        });
      } else {
        mergeSuggestions.push(buildMergeSuggestion(id, kind, entry, decision));
      }
    });
  }

  const allowlist = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    description: 'Generated allowlist candidates for non-actionable PromptContextBlock duplicate groups.',
    entries: allowlistEntries,
  };

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    rules: [
      {
        id: 'template-scaffold-noise',
        classification: 'template-noise',
        condition: 'preview contains <!-- PURPOSE: --> or source heading is Evolution History',
        action: 'allowlist-or-filter-before-merge',
      },
      {
        id: 'generated-mirror-or-allow-repeat',
        classification: 'reasonable-repeat',
        condition: 'sources are generated project standards mirrors or blocks carry dedupePolicy=allowRepeat',
        action: 'allowlist-with-rationale',
      },
      {
        id: 'domain-specific-project-structure-repeat',
        classification: 'domain-specific-repeat',
        condition: 'same Standard Project Structure heading across known domain skills with tree-style project layouts',
        action: 'allowlist-with-domain-specific-rationale',
      },
      {
        id: 'exact-normalized-domain-duplicate',
        classification: 'true-duplicate',
        condition: 'exact/normalized duplicate not explained by template or allow-repeat rules',
        action: 'emit executable merge suggestion',
      },
    ],
    summary: {
      totalGroupsReviewed: entries.length,
      byClassification,
      allowlistCount: allowlistEntries.length,
      mergeSuggestionCount: mergeSuggestions.length,
      estimatedTokenSavings: mergeSuggestions.reduce((sum, item) => sum + item.estimatedTokenSavings, 0),
    },
    entries,
    allowlist,
    mergeSuggestions,
  };
}

function formatMergeSuggestions(governance) {
  const lines = [
    '# PromptContextBlock Merge Suggestions',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| totalGroupsReviewed | ${governance.summary.totalGroupsReviewed} |`,
    `| templateNoise | ${governance.summary.byClassification['template-noise'] || 0} |`,
    `| reasonableRepeat | ${governance.summary.byClassification['reasonable-repeat'] || 0} |`,
    `| domainSpecificRepeat | ${governance.summary.byClassification['domain-specific-repeat'] || 0} |`,
    `| trueDuplicate | ${governance.summary.byClassification['true-duplicate'] || 0} |`,
    `| allowlistCount | ${governance.summary.allowlistCount} |`,
    `| mergeSuggestionCount | ${governance.summary.mergeSuggestionCount} |`,
    `| estimatedTokenSavings | ${governance.summary.estimatedTokenSavings} |`,
    '',
    '## Merge Suggestions',
    '',
  ];

  if (governance.mergeSuggestions.length === 0) lines.push('_No actionable merge suggestions found._');
  for (const item of governance.mergeSuggestions.slice(0, 30)) {
    lines.push(`### ${item.id}`);
    lines.push(`- classification: ${item.classification}`);
    lines.push(`- confidence: ${item.confidence}`);
    lines.push(`- estimatedTokenSavings: ${item.estimatedTokenSavings}`);
    lines.push(`- canonical: \`${item.canonicalBlock.id}\` — ${item.canonicalBlock.source || '(unknown source)'}`);
    for (const duplicate of item.duplicateBlocks) {
      lines.push(`- duplicate: \`${duplicate.id}\` — ${duplicate.source || '(unknown source)'}`);
    }
    lines.push('- steps:');
    item.executableSteps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
    lines.push('');
  }

  lines.push('## Allowlist Summary');
  lines.push('');
  for (const entry of governance.allowlist.entries.slice(0, 30)) {
    lines.push(`- \`${entry.id}\` — ${entry.classification}: ${entry.reason}`);
  }
  lines.push('');
  lines.push('> This governance report is shadow-only. It does not change existing prompt assembly or LLM output.');
  return lines.join('\n');
}

function governanceByBlockId(governance) {
  const map = new Map();
  for (const entry of governance?.entries || []) {
    for (const blockId of entry.blockIds || []) {
      map.set(blockId, {
        entryId: entry.id,
        classification: entry.classification,
        action: entry.action,
        confidence: entry.confidence,
        reason: entry.reason,
      });
    }
  }
  return map;
}

function registryEntryFromBlock(block, governanceMap) {
  const governanceDecision = governanceMap.get(block.id) || null;
  return {
    registryId: `pcb.${sha256(block.id).slice(0, 12)}`,
    blockId: block.id,
    type: block.type,
    owner: block.owner,
    source: block.source,
    sourceHash: block.sourceHash,
    version: block.version,
    stage: block.stage,
    role: block.role,
    priority: block.priority,
    dedupeKey: block.dedupeKey,
    dedupePolicy: block.dedupePolicy,
    contentHash: block.contentHash,
    normalizedHash: block.normalizedHash,
    tokenEstimate: block.tokenEstimate,
    charCount: block.charCount,
    preview: block.preview,
    governance: governanceDecision || {
      classification: 'unique-or-unreviewed',
      action: 'keep',
      confidence: null,
      reason: 'No duplicate governance decision applies to this block.',
    },
  };
}

function summarizeRegistryEntries(entries) {
  const byType = {};
  const byOwner = {};
  const byGovernanceClassification = {};
  for (const entry of entries) {
    byType[entry.type] = (byType[entry.type] || 0) + 1;
    byOwner[entry.owner] = (byOwner[entry.owner] || 0) + 1;
    const classification = entry.governance?.classification || 'unknown';
    byGovernanceClassification[classification] = (byGovernanceClassification[classification] || 0) + 1;
  }
  return { byType, byOwner, byGovernanceClassification };
}

function selectAssemblyEntries(entries, predicate, limit = 80) {
  return entries
    .filter(predicate)
    .sort((a, b) => {
      if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
      if ((a.tokenEstimate || 0) !== (b.tokenEstimate || 0)) return (a.tokenEstimate || 0) - (b.tokenEstimate || 0);
      return a.blockId.localeCompare(b.blockId);
    })
    .slice(0, limit);
}

function assemblyRef(entry, order) {
  return {
    order,
    registryId: entry.registryId,
    blockId: entry.blockId,
    type: entry.type,
    owner: entry.owner,
    source: entry.source,
    priority: entry.priority,
    tokenEstimate: entry.tokenEstimate,
    dedupeKey: entry.dedupeKey,
    governanceClassification: entry.governance?.classification || 'unknown',
  };
}

function buildAssemblyView(id, description, entries) {
  const refs = entries.map((entry, index) => assemblyRef(entry, index + 1));
  return {
    id,
    description,
    blockCount: refs.length,
    estimatedTokens: refs.reduce((sum, ref) => sum + Number(ref.tokenEstimate || 0), 0),
    blocks: refs,
  };
}

function buildPromptContextShadowAssembly(registry) {
  const entries = registry.entries || [];
  const stages = ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST', 'REVIEW', 'DEPLOY'];
  const roles = ['analyst', 'architect', 'planner', 'developer', 'tester'];
  const views = [
    buildAssemblyView('all.priority-order', 'All registry blocks ordered by priority and size. This is a shadow view only.', selectAssemblyEntries(entries, () => true, 120)),
    buildAssemblyView('skills.priority-order', 'Skill blocks ordered by priority and size for future ContextLoader assembly comparison.', selectAssemblyEntries(entries, entry => entry.type === 'skill', 120)),
    buildAssemblyView('runtime-sources.priority-order', 'Runtime prompt/config/source blocks ordered by priority for future prompt assembly diffing.', selectAssemblyEntries(entries, entry => entry.type !== 'skill', 120)),
  ];

  for (const stage of stages) {
    const stageEntries = selectAssemblyEntries(entries, entry => (entry.stage || []).includes(stage), 80);
    if (stageEntries.length > 0) views.push(buildAssemblyView(`stage.${stage}`, `Blocks explicitly tagged for ${stage}.`, stageEntries));
  }
  for (const role of roles) {
    const roleEntries = selectAssemblyEntries(entries, entry => (entry.role || []).includes(role), 80);
    if (roleEntries.length > 0) views.push(buildAssemblyView(`role.${role}`, `Blocks explicitly tagged for role ${role}.`, roleEntries));
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    description: 'Shadow assembly views derived from PromptContextRegistry. These views do not replace buildAgentPrompt, ContextLoader, or workflow-stage runtime assembly.',
    summary: {
      totalViews: views.length,
      totalReferencedBlocks: views.reduce((sum, view) => sum + view.blockCount, 0),
      totalReferencedTokens: views.reduce((sum, view) => sum + view.estimatedTokens, 0),
    },
    views,
  };
}

function buildPromptContextRegistry({ inventory, governance }) {
  const governanceMap = governanceByBlockId(governance);
  const entries = (inventory?.blocks || []).map(block => registryEntryFromBlock(block, governanceMap));
  const summaries = summarizeRegistryEntries(entries);
  const registry = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    projectRoot: inventory?.projectRoot || null,
    sourceArtifacts: {
      inventory: 'output/prompt-context-inventory.json',
      governance: 'output/prompt-context-duplicate-governance.json',
    },
    summary: {
      totalBlocks: entries.length,
      totalEstimatedTokens: entries.reduce((sum, entry) => sum + Number(entry.tokenEstimate || 0), 0),
      totalChars: entries.reduce((sum, entry) => sum + Number(entry.charCount || 0), 0),
      ...summaries,
    },
    entries,
  };
  return {
    registry,
    shadowAssembly: buildPromptContextShadowAssembly(registry),
  };
}

function formatShadowAssemblyReport(shadowAssembly) {
  const lines = [
    '# PromptContextRegistry Shadow Assembly',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${shadowAssembly.changedPromptOutput} |`,
    `| totalViews | ${shadowAssembly.summary.totalViews} |`,
    `| totalReferencedBlocks | ${shadowAssembly.summary.totalReferencedBlocks} |`,
    `| totalReferencedTokens | ${shadowAssembly.summary.totalReferencedTokens} |`,
    '',
    '## Views',
    '',
  ];
  for (const view of shadowAssembly.views) {
    lines.push(`### ${view.id}`);
    lines.push(`- description: ${view.description}`);
    lines.push(`- blockCount: ${view.blockCount}`);
    lines.push(`- estimatedTokens: ${view.estimatedTokens}`);
    for (const block of view.blocks.slice(0, 20)) {
      lines.push(`- ${block.order}. \`${block.blockId}\` — ${block.owner}/${block.type} — ${block.source || '(unknown source)'}`);
    }
    if (view.blocks.length > 20) lines.push(`- ... ${view.blocks.length - 20} more block(s)`);
    lines.push('');
  }
  lines.push('> This registry and assembly report is shadow-only. It does not change existing prompt assembly or LLM output.');
  return lines.join('\n');
}

function textTokens(value) {
  return (normalizeContent(value).match(/[a-z0-9_]{3,}|[\u4e00-\u9fff]{2,}/g) || []).slice(0, 2000);
}

function comparePromptTexts(candidatePrompt, runtimePrompt) {
  const candidateTokens = new Set(textTokens(candidatePrompt));
  const runtimeTokens = new Set(textTokens(runtimePrompt));
  let common = 0;
  for (const token of candidateTokens) if (runtimeTokens.has(token)) common++;
  const union = candidateTokens.size + runtimeTokens.size - common;
  const candidateOnly = [...candidateTokens].filter(token => !runtimeTokens.has(token)).slice(0, 30);
  const runtimeOnly = [...runtimeTokens].filter(token => !candidateTokens.has(token)).slice(0, 30);
  return {
    candidateChars: String(candidatePrompt || '').length,
    runtimeChars: String(runtimePrompt || '').length,
    candidateTokenCount: candidateTokens.size,
    runtimeTokenCount: runtimeTokens.size,
    commonTokenCount: common,
    jaccardSimilarity: union > 0 ? Number((common / union).toFixed(4)) : 0,
    candidateOnlyTop: candidateOnly,
    runtimeOnlyTop: runtimeOnly,
  };
}

function viewById(shadowAssembly, id) {
  return (shadowAssembly?.views || []).find(view => view.id === id) || null;
}

function registryEntryMap(registry) {
  return new Map((registry?.entries || []).map(entry => [entry.registryId, entry]));
}

function mergeAssemblyRefs(shadowAssembly, viewIds, maxBlocks = 60) {
  const seen = new Set();
  const refs = [];
  for (const viewId of viewIds) {
    const view = viewById(shadowAssembly, viewId);
    for (const ref of view?.blocks || []) {
      if (seen.has(ref.registryId)) continue;
      seen.add(ref.registryId);
      refs.push({ ...ref, sourceView: viewId });
      if (refs.length >= maxBlocks) return refs;
    }
  }
  return refs;
}

function refFromEntry(entry, sourceView, order = 1) {
  return {
    order,
    registryId: entry.registryId,
    blockId: entry.blockId,
    type: entry.type,
    owner: entry.owner,
    source: entry.source,
    priority: entry.priority,
    tokenEstimate: entry.tokenEstimate,
    dedupeKey: entry.dedupeKey,
    governanceClassification: entry.governance?.classification || 'unknown',
    sourceView,
  };
}

function rolePrefixEntry(role, entryMap) {
  for (const entry of entryMap.values()) {
    if (entry.blockId === `prompt-agent-prefix.${role}`) return entry;
  }
  return null;
}

function selectRoleSpecificRefs(role, shadowAssembly, entryMap) {
  const refs = [];
  const seen = new Set();
  const addRef = (ref) => {
    if (!ref || seen.has(ref.registryId)) return;
    seen.add(ref.registryId);
    refs.push({ ...ref, order: refs.length + 1 });
  };

  const prefix = rolePrefixEntry(role, entryMap);
  if (prefix) addRef(refFromEntry(prefix, `role-prefix.${role}`));

  const roleView = viewById(shadowAssembly, `role.${role}`);
  for (const ref of roleView?.blocks || []) {
    if (refs.length >= 6) break;
    if (ref.blockId === `prompt-agent-prefix.${role}`) continue;
    addRef({ ...ref, sourceView: `role.${role}` });
  }

  if (refs.length === 0) {
    mergeAssemblyRefs(shadowAssembly, ['runtime-sources.priority-order'], 4).forEach(addRef);
  }
  return refs;
}

function extractMarkdownSection(content, heading) {
  const sections = splitMarkdownHeadingBlocks(content);
  const found = sections.find(section => section.heading === heading);
  return found ? found.content : '';
}

function resolveFullBlockContent(projectRoot, entry) {
  if (!entry) return '';
  const roleMatch = String(entry.blockId || '').match(/^prompt-agent-prefix\.(.+)$/);
  if (roleMatch) {
    try {
      const prefixesPath = path.join(projectRoot || process.cwd(), 'workflow', 'core', 'prompt-agent-prefixes.js');
      delete require.cache[require.resolve(prefixesPath)];
      const { AGENT_FIXED_PREFIXES } = require(prefixesPath);
      return AGENT_FIXED_PREFIXES?.[roleMatch[1]] || String(entry.preview || '');
    } catch {
      return String(entry.preview || '');
    }
  }

  const source = String(entry.source || '');
  const [sourcePath, heading] = source.split('#');
  if (sourcePath && heading && sourcePath.endsWith('.md')) {
    const content = safeRead(path.join(projectRoot || process.cwd(), sourcePath));
    const section = extractMarkdownSection(content, heading);
    if (section) return section;
  }
  return String(entry.preview || '');
}

function renderCandidatePrompt(role, refs, entryMap, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const lines = [
    `# Shadow Candidate Prompt — ${role}`,
    '<!-- shadow-only: diagnostic candidate, not runtime output -->',
    '',
  ];
  refs.forEach((ref, index) => {
    const entry = entryMap.get(ref.registryId) || {};
    lines.push(`<!-- block:${index + 1} ${ref.blockId} sourceView=${ref.sourceView} -->`);
    lines.push(resolveFullBlockContent(projectRoot, entry).trim());
    lines.push('');
  });
  return lines.join('\n').trim() + '\n';
}

function loadRuntimePromptSnapshots(projectRoot, requestedRoles) {
  const prefixesPath = path.join(projectRoot || process.cwd(), 'workflow', 'core', 'prompt-agent-prefixes.js');
  try {
    delete require.cache[require.resolve(prefixesPath)];
    const { AGENT_FIXED_PREFIXES } = require(prefixesPath);
    const roles = requestedRoles?.length ? requestedRoles : Object.keys(AGENT_FIXED_PREFIXES || {});
    return roles
      .filter(role => AGENT_FIXED_PREFIXES && AGENT_FIXED_PREFIXES[role])
      .map(role => ({
        role,
        source: 'workflow/core/prompt-agent-prefixes.js',
        runtimePromptHash: sha256(AGENT_FIXED_PREFIXES[role]),
        runtimePromptLength: AGENT_FIXED_PREFIXES[role].length,
        runtimePrompt: AGENT_FIXED_PREFIXES[role],
      }));
  } catch (err) {
    return [{
      role: 'unknown',
      source: 'workflow/core/prompt-agent-prefixes.js',
      error: err.message,
      runtimePromptHash: null,
      runtimePromptLength: 0,
      runtimePrompt: '',
    }];
  }
}

function buildPromptContextAssemblerShadowDiff({ registry, shadowAssembly, runtimePrompts }) {
  const entryMap = registryEntryMap(registry);
  const snapshots = runtimePrompts?.length ? runtimePrompts : loadRuntimePromptSnapshots(registry?.projectRoot || process.cwd());
  const candidatePrompts = [];
  const roleDiffs = [];

  for (const snapshot of snapshots) {
    const role = snapshot.role;
    const refs = selectRoleSpecificRefs(role, shadowAssembly, entryMap);
    const candidatePrompt = renderCandidatePrompt(role, refs, entryMap, { projectRoot: registry?.projectRoot });
    const comparison = comparePromptTexts(candidatePrompt, snapshot.runtimePrompt || '');
    const runtimeLength = Number(snapshot.runtimePromptLength || 0);
    const candidateLength = candidatePrompt.length;
    const candidate = {
      role,
      mode: 'shadow-only',
      changedPromptOutput: false,
      selectionStrategy: 'role-specific-prefix-first',
      sourceViews: [...new Set(refs.map(ref => ref.sourceView))],
      blockCount: refs.length,
      estimatedTokens: refs.reduce((sum, ref) => sum + Number(ref.tokenEstimate || 0), 0),
      candidatePromptHash: sha256(candidatePrompt),
      candidatePromptLength: candidateLength,
      runtimePrefixCoverage: comparison.runtimeTokenCount > 0
        ? Number((comparison.commonTokenCount / comparison.runtimeTokenCount).toFixed(4))
        : 0,
      lengthRatioToRuntime: runtimeLength > 0 ? Number((candidateLength / runtimeLength).toFixed(4)) : null,
      candidatePrompt,
      blocks: refs,
    };
    candidatePrompts.push(candidate);
    roleDiffs.push({
      role,
      runtimePromptSource: snapshot.source,
      runtimePromptHash: snapshot.runtimePromptHash,
      runtimePromptLength: snapshot.runtimePromptLength,
      candidatePromptHash: candidate.candidatePromptHash,
      candidatePromptLength: candidate.candidatePromptLength,
      sourceViews: candidate.sourceViews,
      selectionStrategy: candidate.selectionStrategy,
      blockCount: candidate.blockCount,
      estimatedTokens: candidate.estimatedTokens,
      runtimePrefixCoverage: candidate.runtimePrefixCoverage,
      lengthRatioToRuntime: candidate.lengthRatioToRuntime,
      comparison,
      interpretation: 'Shadow candidate uses role-specific full prefix content first, then minimal registry refs. It is still diagnostic only and must not be used as runtime output.',
    });
  }

  const averageSimilarity = roleDiffs.length
    ? Number((roleDiffs.reduce((sum, diff) => sum + diff.comparison.jaccardSimilarity, 0) / roleDiffs.length).toFixed(4))
    : 0;
  const averageRuntimePrefixCoverage = roleDiffs.length
    ? Number((roleDiffs.reduce((sum, diff) => sum + Number(diff.runtimePrefixCoverage || 0), 0) / roleDiffs.length).toFixed(4))
    : 0;
  const averageLengthRatioToRuntime = roleDiffs.length
    ? Number((roleDiffs.reduce((sum, diff) => sum + Number(diff.lengthRatioToRuntime || 0), 0) / roleDiffs.length).toFixed(4))
    : 0;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: {
      rolesCompared: roleDiffs.length,
      candidatePromptCount: candidatePrompts.length,
      averageJaccardSimilarity: averageSimilarity,
      averageRuntimePrefixCoverage,
      averageLengthRatioToRuntime,
      totalCandidateBlocks: candidatePrompts.reduce((sum, candidate) => sum + candidate.blockCount, 0),
      totalCandidateEstimatedTokens: candidatePrompts.reduce((sum, candidate) => sum + candidate.estimatedTokens, 0),
    },
    candidatePrompts,
    roleDiffs,
  };
}

function formatAssemblerShadowDiffReport(diff) {
  const lines = [
    '# PromptContextAssembler Shadow Diff',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${diff.changedPromptOutput} |`,
    `| rolesCompared | ${diff.summary.rolesCompared} |`,
    `| candidatePromptCount | ${diff.summary.candidatePromptCount} |`,
    `| averageJaccardSimilarity | ${diff.summary.averageJaccardSimilarity} |`,
    `| averageRuntimePrefixCoverage | ${diff.summary.averageRuntimePrefixCoverage} |`,
    `| averageLengthRatioToRuntime | ${diff.summary.averageLengthRatioToRuntime} |`,
    `| totalCandidateBlocks | ${diff.summary.totalCandidateBlocks} |`,
    `| totalCandidateEstimatedTokens | ${diff.summary.totalCandidateEstimatedTokens} |`,
    '',
    '## Role Diffs',
    '',
  ];
  for (const item of diff.roleDiffs) {
    lines.push(`### ${item.role}`);
    lines.push(`- runtimePromptLength: ${item.runtimePromptLength}`);
    lines.push(`- candidatePromptLength: ${item.candidatePromptLength}`);
    lines.push(`- selectionStrategy: ${item.selectionStrategy}`);
    lines.push(`- blockCount: ${item.blockCount}`);
    lines.push(`- estimatedTokens: ${item.estimatedTokens}`);
    lines.push(`- jaccardSimilarity: ${item.comparison.jaccardSimilarity}`);
    lines.push(`- runtimePrefixCoverage: ${item.runtimePrefixCoverage}`);
    lines.push(`- lengthRatioToRuntime: ${item.lengthRatioToRuntime}`);
    lines.push(`- sourceViews: ${item.sourceViews.join(', ') || '(none)'}`);
    lines.push(`- runtimeOnlyTop: ${item.comparison.runtimeOnlyTop.slice(0, 12).join(', ') || '(none)'}`);
    lines.push(`- candidateOnlyTop: ${item.comparison.candidateOnlyTop.slice(0, 12).join(', ') || '(none)'}`);
    lines.push('');
  }
  lines.push('> This shadow diff is diagnostic only. It does not replace buildAgentPrompt, ContextLoader, workflow-stage, or any runtime prompt output.');
  return lines.join('\n');
}

function sourceBase(source) {
  return String(source || '')
    .split('#')[0]
    .replace(/\s+\([^)]*sections? for [^)]+\)$/i, '')
    .replace(/\s+\(summary, overlap=[^)]+\)$/i, '')
    .replace(/\\/g, '/')
    .trim();
}

function dynamicContextRegistryEntries(registry) {
  const dynamicTypes = new Set([
    'skill',
    'stage-digest',
    'context-loader-source',
    'context-loader-doc',
    'context-loader-artifact',
    'mandatory-doc-map',
    'constraint-section-map',
    'skill-keyword-map',
    'skill-role-filter',
    'risk-skill-pack',
    'project-rule',
  ]);
  return (registry?.entries || []).filter(entry => dynamicTypes.has(entry.type) || entry.owner === 'ContextLoader');
}

function tokenOverlapScore(a, b) {
  const aTokens = new Set(textTokens(a));
  const bTokens = new Set(textTokens(b));
  if (aTokens.size === 0 || bTokens.size === 0) return { score: 0, covered: 0, total: aTokens.size };
  let common = 0;
  for (const token of aTokens) if (bTokens.has(token)) common++;
  return {
    score: Number((common / aTokens.size).toFixed(4)),
    covered: common,
    total: aTokens.size,
  };
}

function bestRegistryMatchForContextSection(section, entries, projectRoot) {
  const sectionSource = sourceBase(section.source);
  let best = null;
  for (const entry of entries) {
    const entrySource = sourceBase(entry.source);
    const sourceBoost = sectionSource && entrySource && (sectionSource === entrySource || entrySource.endsWith(sectionSource) || sectionSource.endsWith(entrySource)) ? 0.35 : 0;
    const content = resolveFullBlockContent(projectRoot, entry);
    const overlap = tokenOverlapScore(section.content || '', content || entry.preview || '');
    const score = Math.min(1, overlap.score + sourceBoost);
    if (!best || score > best.score) {
      best = {
        score,
        tokenCoverage: overlap.score,
        coveredTokens: overlap.covered,
        totalTokens: overlap.total,
        registryId: entry.registryId,
        blockId: entry.blockId,
        type: entry.type,
        owner: entry.owner,
        source: entry.source,
        governanceClassification: entry.governance?.classification || 'unknown',
      };
    }
  }
  return best;
}

function buildPromptContextDynamicContextShadowDiff({ registry, injectedContexts, projectRoot }) {
  const entries = dynamicContextRegistryEntries(registry);
  const contexts = injectedContexts || [];
  const roleDiffs = [];
  let totalSections = 0;
  let matchedSections = 0;
  let coverageSum = 0;

  for (const context of contexts) {
    const sectionDiffs = [];
    for (const section of context.sections || []) {
      totalSections++;
      const match = bestRegistryMatchForContextSection(section, entries, projectRoot || registry?.projectRoot || process.cwd());
      const matched = Boolean(match && match.score >= 0.35);
      if (matched) matchedSections++;
      coverageSum += match ? match.score : 0;
      sectionDiffs.push({
        index: section.index,
        source: section.source,
        charCount: String(section.content || '').length,
        matched,
        match,
      });
    }
    const covered = sectionDiffs.filter(item => item.matched).length;
    roleDiffs.push({
      stage: context.stage,
      role: context.role,
      taskText: context.taskText,
      injectedSections: sectionDiffs.length,
      matchedSections: covered,
      sectionCoverage: sectionDiffs.length ? Number((covered / sectionDiffs.length).toFixed(4)) : 0,
      averageMatchScore: sectionDiffs.length ? Number((sectionDiffs.reduce((sum, item) => sum + (item.match?.score || 0), 0) / sectionDiffs.length).toFixed(4)) : 0,
      tokenCount: context.tokenCount || 0,
      sources: context.sources || [],
      sectionDiffs,
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    summary: {
      contextsCompared: contexts.length,
      registryCandidateBlocks: entries.length,
      totalInjectedSections: totalSections,
      matchedInjectedSections: matchedSections,
      sectionCoverage: totalSections ? Number((matchedSections / totalSections).toFixed(4)) : 0,
      averageMatchScore: totalSections ? Number((coverageSum / totalSections).toFixed(4)) : 0,
    },
    roleDiffs,
  };
}

function formatDynamicContextShadowDiffReport(diff) {
  const lines = [
    '# PromptContextAssembler Dynamic Context Shadow Diff',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${diff.changedPromptOutput} |`,
    `| contextsCompared | ${diff.summary.contextsCompared} |`,
    `| registryCandidateBlocks | ${diff.summary.registryCandidateBlocks} |`,
    `| totalInjectedSections | ${diff.summary.totalInjectedSections} |`,
    `| matchedInjectedSections | ${diff.summary.matchedInjectedSections} |`,
    `| sectionCoverage | ${diff.summary.sectionCoverage} |`,
    `| averageMatchScore | ${diff.summary.averageMatchScore} |`,
    '',
    '## Context Diffs',
    '',
  ];
  for (const item of diff.roleDiffs) {
    lines.push(`### ${item.stage}/${item.role}`);
    lines.push(`- injectedSections: ${item.injectedSections}`);
    lines.push(`- matchedSections: ${item.matchedSections}`);
    lines.push(`- sectionCoverage: ${item.sectionCoverage}`);
    lines.push(`- averageMatchScore: ${item.averageMatchScore}`);
    lines.push(`- tokenCount: ${item.tokenCount}`);
    lines.push(`- sources: ${item.sources.slice(0, 8).join(', ') || '(none)'}`);
    for (const section of item.sectionDiffs.slice(0, 12)) {
      lines.push(`  - section[${section.index}] ${section.matched ? 'MATCH' : 'MISS'} source=${section.source || '(unknown)'} match=${section.match?.blockId || '(none)'} score=${section.match?.score ?? 0}`);
    }
    if (item.sectionDiffs.length > 12) lines.push(`  - ... ${item.sectionDiffs.length - 12} more section(s)`);
    lines.push('');
  }
  lines.push('> This dynamic context diff is diagnostic only. It does not replace ContextLoader, buildAgentPrompt, workflow-stage, or any runtime prompt output.');
  return lines.join('\n');
}

const DEFAULT_SELECTION_BUDGET = {
  perRoleMaxBlocks: 6,
  perRoleMaxTokens: 900,
  globalMaxBlocks: 32,
  globalMaxTokens: 4200,
  minMatchScore: 0.65,
  warnMatchScore: 0.75,
};

function isContextLoaderDocArtifact(type) {
  return type === 'context-loader-doc' || type === 'context-loader-artifact';
}

function buildSelectionRef(section, entry) {
  return {
    registryId: entry.registryId,
    blockId: entry.blockId,
    type: entry.type,
    source: entry.source,
    sourceHash: entry.sourceHash,
    tokenEstimate: Number(entry.tokenEstimate || 0),
    charCount: Number(entry.charCount || 0),
    matchScore: section.match?.score || 0,
    tokenCoverage: section.match?.tokenCoverage || 0,
    injectedSource: section.source,
    injectedCharCount: section.charCount,
  };
}

function buildPromptContextSelectionBudget({ registry, dynamicContextDiff, budget }) {
  const effectiveBudget = { ...DEFAULT_SELECTION_BUDGET, ...(budget || {}) };
  const entryMap = registryEntryMap(registry);
  const roleBudgets = [];
  const driftAlerts = [];
  let globalBlocks = 0;
  let globalTokens = 0;

  if ((dynamicContextDiff?.summary?.sectionCoverage || 0) < 1) {
    driftAlerts.push({
      severity: 'high',
      type: 'coverage-drop',
      message: `Dynamic context sectionCoverage is ${dynamicContextDiff?.summary?.sectionCoverage || 0}; inspect misses before any runtime migration.`,
    });
  }

  for (const roleDiff of dynamicContextDiff?.roleDiffs || []) {
    const selectedBlocks = [];
    const omittedBlocks = [];
    const seen = new Set();
    let roleTokens = 0;

    for (const section of roleDiff.sectionDiffs || []) {
      if (!section.matched) {
        driftAlerts.push({
          severity: 'high',
          type: 'unmatched-injection',
          stage: roleDiff.stage,
          role: roleDiff.role,
          source: section.source,
          message: 'Injected ContextLoader section is not covered by PromptContextRegistry.',
        });
        continue;
      }
      if (!isContextLoaderDocArtifact(section.match?.type)) continue;
      const entry = entryMap.get(section.match.registryId);
      if (!entry || seen.has(entry.registryId)) continue;
      seen.add(entry.registryId);
      const ref = buildSelectionRef(section, entry);
      const wouldExceedRole = selectedBlocks.length >= effectiveBudget.perRoleMaxBlocks
        || roleTokens + ref.tokenEstimate > effectiveBudget.perRoleMaxTokens;
      const wouldExceedGlobal = globalBlocks >= effectiveBudget.globalMaxBlocks
        || globalTokens + ref.tokenEstimate > effectiveBudget.globalMaxTokens;

      if ((section.match.score || 0) < effectiveBudget.warnMatchScore) {
        driftAlerts.push({
          severity: (section.match.score || 0) < effectiveBudget.minMatchScore ? 'medium' : 'low',
          type: 'low-match-score',
          stage: roleDiff.stage,
          role: roleDiff.role,
          source: section.source,
          match: section.match.blockId,
          score: section.match.score,
          message: 'Matched registry block is below preferred confidence threshold; keep as diagnostic until reviewed.',
        });
      }
      if (!entry.sourceHash) {
        driftAlerts.push({
          severity: 'low',
          type: 'missing-source-hash',
          stage: roleDiff.stage,
          role: roleDiff.role,
          source: entry.source,
          message: 'Selected registry block has no sourceHash; drift detection may be weaker.',
        });
      }

      if (wouldExceedRole || wouldExceedGlobal) {
        omittedBlocks.push({ ...ref, reason: wouldExceedGlobal ? 'global-budget-exceeded' : 'role-budget-exceeded' });
        driftAlerts.push({
          severity: 'info',
          type: 'budget-omission',
          stage: roleDiff.stage,
          role: roleDiff.role,
          source: entry.source,
          message: `${entry.blockId} omitted from shadow selection because ${wouldExceedGlobal ? 'global' : 'role'} budget would be exceeded.`,
        });
        continue;
      }

      selectedBlocks.push(ref);
      roleTokens += ref.tokenEstimate;
      globalBlocks++;
      globalTokens += ref.tokenEstimate;
    }

    roleBudgets.push({
      stage: roleDiff.stage,
      role: roleDiff.role,
      injectedSections: roleDiff.injectedSections,
      selectedBlocks: selectedBlocks.length,
      selectedEstimatedTokens: roleTokens,
      omittedBlocks: omittedBlocks.length,
      budget: {
        maxBlocks: effectiveBudget.perRoleMaxBlocks,
        maxTokens: effectiveBudget.perRoleMaxTokens,
      },
      blocks: selectedBlocks,
      omissions: omittedBlocks,
    });
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    description: 'Shadow selection budget for context-loader-doc/artifact registry blocks. This report is diagnostic only and does not change runtime prompt output.',
    budget: effectiveBudget,
    summary: {
      rolesCompared: roleBudgets.length,
      selectedBlocks: roleBudgets.reduce((sum, item) => sum + item.selectedBlocks, 0),
      selectedEstimatedTokens: roleBudgets.reduce((sum, item) => sum + item.selectedEstimatedTokens, 0),
      omittedBlocks: roleBudgets.reduce((sum, item) => sum + item.omittedBlocks, 0),
      driftAlertCount: driftAlerts.length,
      highDriftAlertCount: driftAlerts.filter(alert => alert.severity === 'high').length,
    },
    roleBudgets,
    driftAlerts,
  };
}

function stageOutputPath(stage) {
  const map = {
    ANALYSE: 'output/analysis.md',
    ARCHITECT: 'output/architecture.md',
    PLAN: 'output/execution-plan.md',
    DEVELOP: 'output/code.diff',
    TEST: 'output/test-report.md',
    REVIEW: 'output/review-output.md',
    DEPLOY: 'output/deploy-output.md',
  };
  return map[stage] || 'output/stage-output.md';
}

function buildStageInstructionSnapshot(stage) {
  return [
    `Execute the ${stage} stage using the provided context and prompt.`,
    `Write output to: ${stageOutputPath(stage)}.`,
    'Respect shadow-only diagnostics: do not change runtime prompt output from candidate prompt artifacts.',
  ].join('\n');
}

function fullPromptStageRoles() {
  return [
    ['ANALYSE', 'analyst'],
    ['ARCHITECT', 'architect'],
    ['PLAN', 'planner'],
    ['DEVELOP', 'developer'],
    ['TEST', 'tester'],
  ];
}

function loadFixedPrefix(projectRoot, role) {
  const prefixesPath = path.join(projectRoot || process.cwd(), 'workflow', 'core', 'prompt-agent-prefixes.js');
  try {
    delete require.cache[require.resolve(prefixesPath)];
    const { AGENT_FIXED_PREFIXES } = require(prefixesPath);
    return AGENT_FIXED_PREFIXES?.[role] || '';
  } catch {
    return '';
  }
}

function buildRuntimeParitySections() {
  try {
    const { buildRuntimeSupplementSections } = require('./prompt-runtime-supplement-builder');
    return buildRuntimeSupplementSections();
  } catch {
    return [];
  }
}

function renderFullCandidatePrompt({ projectRoot, stage, role, requirement, context }) {
  const fixedPrefix = loadFixedPrefix(projectRoot, role);
  const dynamicSections = (context?.sections || []).map(section => section.content).filter(Boolean);
  const dynamicSuffix = [
    ...dynamicSections,
    ...buildRuntimeParitySections(),
    `### Input\n${requirement || 'PromptContextAssembler full prompt shadow parity'}`,
    `## Stage Instructions\n\n${buildStageInstructionSnapshot(stage)}`,
  ].join('\n\n');
  return fixedPrefix + '\n\n<!-- KV_CACHE_BOUNDARY: dynamic content below -->\n\n' + dynamicSuffix;
}


async function loadRuntimeFullPromptSnapshot({ projectRoot, stage, role, requirement }) {
  try {
    const { buildAgentPrompt } = require('./prompt-builder');
    const result = await buildAgentPrompt(role, requirement || 'PromptContextAssembler full prompt shadow parity', [], {
      projectRoot,
      stage,
      usePatterns: false,
      trackMetrics: false,
    });
    const runtimePrompt = `${result.prompt}\n\n## Stage Instructions\n\n${buildStageInstructionSnapshot(stage)}`;
    return {
      stage,
      role,
      source: 'workflow/core/prompt-builder.js + workflow/tools/ide-workflow-bridge.js#workflow-stage.instructions',
      runtimePromptHash: sha256(runtimePrompt),
      runtimePromptLength: runtimePrompt.length,
      runtimePrompt,
      meta: result.meta || {},
    };
  } catch (err) {
    const fallback = `${loadFixedPrefix(projectRoot, role)}\n\n## Stage Instructions\n\n${buildStageInstructionSnapshot(stage)}`;
    return {
      stage,
      role,
      source: 'fallback:prompt-agent-prefixes + stage instructions',
      error: err.message,
      runtimePromptHash: sha256(fallback),
      runtimePromptLength: fallback.length,
      runtimePrompt: fallback,
    };
  }
}

async function resolveFullPromptContextSnapshots(projectRoot, requirement) {
  const ContextLoader = require('./context-loader').ContextLoader || require('./context-loader');
  const configPath = path.join(projectRoot, 'workflow.config.js');
  let config = {};
  try {
    delete require.cache[require.resolve(configPath)];
    if (fs.existsSync(configPath)) config = require(configPath);
  } catch { config = {}; }
  const loader = new ContextLoader({
    workflowRoot: path.join(projectRoot, 'workflow'),
    projectRoot,
    skillKeywords: config.skillKeywords || {},
    alwaysLoadSkills: config.alwaysLoadSkills || [],
    globalSkills: config.globalSkills || [],
    projectSkills: config.projectSkills || [],
    registeredSkills: config.builtinSkills || [],
  });
  const contexts = [];
  for (const [stage, role] of fullPromptStageRoles()) {
    const resolved = await loader.resolve(requirement || 'PromptContextAssembler full prompt shadow parity', role, { stage });
    const sources = resolved.sources || [];
    contexts.push({
      stage,
      role,
      taskText: requirement || '',
      tokenCount: resolved.tokenCount || 0,
      sources,
      sections: (resolved.sections || []).map((content, index) => ({
        index,
        source: sources[index] || 'unknown',
        content,
      })),
    });
  }
  return contexts;
}

async function buildPromptContextFullPromptShadowParity({ projectRoot, requirement, contexts }) {
  const actualProjectRoot = path.resolve(projectRoot || process.cwd());
  const contextSnapshots = contexts || await resolveFullPromptContextSnapshots(actualProjectRoot, requirement);
  const candidatePrompts = [];
  const runtimePrompts = [];
  const roleDiffs = [];

  for (const context of contextSnapshots) {
    const candidatePrompt = renderFullCandidatePrompt({
      projectRoot: actualProjectRoot,
      stage: context.stage,
      role: context.role,
      requirement,
      context,
    });
    const runtime = await loadRuntimeFullPromptSnapshot({
      projectRoot: actualProjectRoot,
      stage: context.stage,
      role: context.role,
      requirement,
    });
    const comparison = comparePromptTexts(candidatePrompt, runtime.runtimePrompt || '');
    const runtimeTokenCoverage = comparison.runtimeTokenCount > 0
      ? Number((comparison.commonTokenCount / comparison.runtimeTokenCount).toFixed(4))
      : 0;
    runtimePrompts.push({
      stage: context.stage,
      role: context.role,
      mode: 'runtime-snapshot',
      changedPromptOutput: false,
      source: runtime.source,
      runtimePromptHash: runtime.runtimePromptHash,
      runtimePromptLength: runtime.runtimePromptLength,
      runtimePrompt: runtime.runtimePrompt || '',
      runtimeMeta: runtime.meta || null,
      runtimeError: runtime.error || null,
    });
    candidatePrompts.push({
      stage: context.stage,
      role: context.role,
      mode: 'shadow-only',
      changedPromptOutput: false,
      candidatePromptHash: sha256(candidatePrompt),
      candidatePromptLength: candidatePrompt.length,
      contextSections: context.sections.length,
      contextTokenCount: context.tokenCount,
      candidatePrompt,
    });
    roleDiffs.push({
      stage: context.stage,
      role: context.role,
      runtimePromptSource: runtime.source,
      runtimePromptHash: runtime.runtimePromptHash,
      runtimePromptLength: runtime.runtimePromptLength,
      candidatePromptHash: sha256(candidatePrompt),
      candidatePromptLength: candidatePrompt.length,
      contextSections: context.sections.length,
      contextTokenCount: context.tokenCount,
      runtimeTokenCoverage,
      jaccardSimilarity: comparison.jaccardSimilarity,
      comparison,
      runtimeMeta: runtime.meta || null,
      runtimeError: runtime.error || null,
    });
  }

  const averageRuntimeTokenCoverage = roleDiffs.length
    ? Number((roleDiffs.reduce((sum, item) => sum + item.runtimeTokenCoverage, 0) / roleDiffs.length).toFixed(4))
    : 0;
  const averageJaccardSimilarity = roleDiffs.length
    ? Number((roleDiffs.reduce((sum, item) => sum + item.jaccardSimilarity, 0) / roleDiffs.length).toFixed(4))
    : 0;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    description: 'Full prompt shadow parity compares registry-derived candidate prompts with current runtime prompt snapshots. It does not change runtime output.',
    summary: {
      rolesCompared: roleDiffs.length,
      candidatePromptCount: candidatePrompts.length,
      averageRuntimeTokenCoverage,
      averageJaccardSimilarity,
      totalCandidateLength: candidatePrompts.reduce((sum, item) => sum + item.candidatePromptLength, 0),
      totalRuntimeLength: roleDiffs.reduce((sum, item) => sum + item.runtimePromptLength, 0),
    },
    candidatePrompts,
    runtimePrompts,
    roleDiffs,
  };
}

function buildDualWriteRollbackGate(fullPromptParity, options = {}) {
  const thresholds = {
    minAverageRuntimeTokenCoverage: 0.9,
    minRoleRuntimeTokenCoverage: 0.85,
    minAverageJaccardSimilarity: 0.85,
    allowRuntimeErrors: false,
    ...(options.thresholds || {}),
  };
  const checks = [
    {
      id: 'changed-prompt-output',
      passed: fullPromptParity.changedPromptOutput === false,
      actual: fullPromptParity.changedPromptOutput,
      expected: false,
      severity: 'critical',
    },
    {
      id: 'average-runtime-token-coverage',
      passed: fullPromptParity.summary.averageRuntimeTokenCoverage >= thresholds.minAverageRuntimeTokenCoverage,
      actual: fullPromptParity.summary.averageRuntimeTokenCoverage,
      expected: `>=${thresholds.minAverageRuntimeTokenCoverage}`,
      severity: 'high',
    },
    {
      id: 'average-jaccard-similarity',
      passed: fullPromptParity.summary.averageJaccardSimilarity >= thresholds.minAverageJaccardSimilarity,
      actual: fullPromptParity.summary.averageJaccardSimilarity,
      expected: `>=${thresholds.minAverageJaccardSimilarity}`,
      severity: 'medium',
    },
    ...fullPromptParity.roleDiffs.map(item => ({
      id: `role-coverage.${item.stage}.${item.role}`,
      stage: item.stage,
      role: item.role,
      passed: item.runtimeTokenCoverage >= thresholds.minRoleRuntimeTokenCoverage,
      actual: item.runtimeTokenCoverage,
      expected: `>=${thresholds.minRoleRuntimeTokenCoverage}`,
      severity: 'high',
    })),
    ...fullPromptParity.roleDiffs.map(item => ({
      id: `runtime-error.${item.stage}.${item.role}`,
      stage: item.stage,
      role: item.role,
      passed: thresholds.allowRuntimeErrors || !item.runtimeError,
      actual: item.runtimeError || null,
      expected: null,
      severity: 'high',
    })),
  ];
  const failed = checks.filter(check => !check.passed);
  return {
    mode: 'rollback-gate',
    passed: failed.length === 0,
    shouldRollback: failed.some(check => check.severity === 'critical' || check.severity === 'high'),
    thresholds,
    summary: {
      totalChecks: checks.length,
      passedChecks: checks.length - failed.length,
      failedChecks: failed.length,
      highOrCriticalFailures: failed.filter(check => check.severity === 'critical' || check.severity === 'high').length,
    },
    checks,
    failed,
  };
}

function buildPromptContextDualWriteCanary({ projectRoot, requirement, contexts, thresholds } = {}) {
  return buildPromptContextFullPromptShadowParity({ projectRoot, requirement, contexts }).then((fullPromptParity) => {
    const runtimeByRole = new Map((fullPromptParity.runtimePrompts || []).map(item => [`${item.stage}/${item.role}`, item]));
    const payloads = fullPromptParity.candidatePrompts.map(candidate => {
      const runtime = runtimeByRole.get(`${candidate.stage}/${candidate.role}`) || {};
      const roleDiff = fullPromptParity.roleDiffs.find(item => item.stage === candidate.stage && item.role === candidate.role) || {};
      return {
        stage: candidate.stage,
        role: candidate.role,
        mode: 'dual-write-shadow',
        changedPromptOutput: false,
        runtime: {
          source: runtime.source || null,
          hash: runtime.runtimePromptHash || null,
          length: runtime.runtimePromptLength || 0,
          prompt: runtime.runtimePrompt || '',
          error: runtime.runtimeError || null,
        },
        candidate: {
          source: 'PromptContextAssembler shared-builder candidate',
          hash: candidate.candidatePromptHash,
          length: candidate.candidatePromptLength,
          prompt: candidate.candidatePrompt,
        },
        diff: {
          runtimeTokenCoverage: roleDiff.runtimeTokenCoverage || 0,
          jaccardSimilarity: roleDiff.jaccardSimilarity || 0,
          runtimeOnlyTop: roleDiff.comparison?.runtimeOnlyTop || [],
          candidateOnlyTop: roleDiff.comparison?.candidateOnlyTop || [],
        },
      };
    });
    const rollbackGate = buildDualWriteRollbackGate(fullPromptParity, { thresholds });
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode: 'dual-write-shadow',
      changedPromptOutput: false,
      description: 'Dual-write canary records runtime prompt payloads and shared-builder candidate payloads without changing runtime output.',
      summary: {
        ...fullPromptParity.summary,
        payloadCount: payloads.length,
        rollbackGatePassed: rollbackGate.passed,
        shouldRollback: rollbackGate.shouldRollback,
      },
      payloads,
      rollbackGate,
      roleDiffs: fullPromptParity.roleDiffs,
    };
  });
}

function buildPromptContextMigrationGate(dualWriteCanary, options = {}) {
  const policy = {
    rolloutSwitch: 'PROMPT_CONTEXT_ASSEMBLER_MODE',
    defaultMode: 'runtime',
    canaryMode: 'dual-write-canary',
    candidateMode: 'candidate-runtime',
    recommendedInitialPercent: 0,
    maxManualCanaryPercent: 5,
    requireManualApproval: true,
    ...(options.policy || {}),
  };
  const rollbackGate = dualWriteCanary.rollbackGate || {};
  const checks = [
    {
      id: 'canary-changed-prompt-output',
      passed: dualWriteCanary.changedPromptOutput === false,
      actual: dualWriteCanary.changedPromptOutput,
      expected: false,
      severity: 'critical',
    },
    {
      id: 'dual-write-rollback-gate-passed',
      passed: rollbackGate.passed === true,
      actual: rollbackGate.passed,
      expected: true,
      severity: 'critical',
    },
    {
      id: 'dual-write-should-rollback-false',
      passed: rollbackGate.shouldRollback === false,
      actual: rollbackGate.shouldRollback,
      expected: false,
      severity: 'critical',
    },
    {
      id: 'payload-count-complete',
      passed: (dualWriteCanary.summary?.payloadCount || 0) >= (dualWriteCanary.summary?.rolesCompared || 0),
      actual: dualWriteCanary.summary?.payloadCount || 0,
      expected: `>=${dualWriteCanary.summary?.rolesCompared || 0}`,
      severity: 'high',
    },
    {
      id: 'no-high-critical-gate-failures',
      passed: (rollbackGate.summary?.highOrCriticalFailures || 0) === 0,
      actual: rollbackGate.summary?.highOrCriticalFailures || 0,
      expected: 0,
      severity: 'high',
    },
  ];
  const failed = checks.filter(check => !check.passed);
  const gatePassed = failed.length === 0;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'migration-gate-shadow',
    changedPromptOutput: false,
    description: 'Migration gate consumes dual-write rollback gate and defines rollout switches/rollback strategy without changing runtime output.',
    summary: {
      gatePassed,
      migrationAllowed: false,
      canProceedToManualCanary: gatePassed,
      shouldRollback: !gatePassed || rollbackGate.shouldRollback === true,
      checksPassed: checks.length - failed.length,
      checksTotal: checks.length,
      failedChecks: failed.length,
    },
    policy,
    rolloutSwitch: {
      name: policy.rolloutSwitch,
      currentRequiredValue: policy.defaultMode,
      canaryValue: policy.canaryMode,
      candidateRuntimeValue: policy.candidateMode,
      recommendedInitialPercent: policy.recommendedInitialPercent,
      maxManualCanaryPercent: policy.maxManualCanaryPercent,
      requireManualApproval: policy.requireManualApproval,
      safeDefault: `${policy.rolloutSwitch}=${policy.defaultMode}`,
      canaryCommand: `${policy.rolloutSwitch}=${policy.canaryMode}`,
    },
    rollbackStrategy: {
      trigger: 'Any critical/high migration gate failure, canary rollbackGate failure, runtime error, or operator complaint.',
      immediateAction: `${policy.rolloutSwitch}=${policy.defaultMode}`,
      preserveArtifacts: [
        'output/prompt-context-dual-write-canary.md',
        'output/prompt-context-dual-write-rollback-gate.json',
        'output/prompt-context-migration-gate.json',
      ],
      investigation: [
        'Inspect failed migration gate checks.',
        'Compare runtimeOnlyTop/candidateOnlyTop in dual-write canary report.',
        'Keep runtime prompt path as source of truth until a follow-up /wf fixes the drift.',
      ],
    },
    checks,
    failed,
    source: {
      dualWriteMode: dualWriteCanary.mode,
      dualWriteSummary: dualWriteCanary.summary,
      rollbackGateSummary: rollbackGate.summary || null,
    },
  };
}

function formatMigrationGateReport(report) {
  const lines = [
    '# PromptContextAssembler Migration Gate',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| gatePassed | ${report.summary.gatePassed} |`,
    `| migrationAllowed | ${report.summary.migrationAllowed} |`,
    `| canProceedToManualCanary | ${report.summary.canProceedToManualCanary} |`,
    `| shouldRollback | ${report.summary.shouldRollback} |`,
    `| checksPassed | ${report.summary.checksPassed}/${report.summary.checksTotal} |`,
    '',
    '## Rollout Switch',
    '',
    `- switch: ${report.rolloutSwitch.name}`,
    `- safeDefault: ${report.rolloutSwitch.safeDefault}`,
    `- canaryCommand: ${report.rolloutSwitch.canaryCommand}`,
    `- recommendedInitialPercent: ${report.rolloutSwitch.recommendedInitialPercent}`,
    `- maxManualCanaryPercent: ${report.rolloutSwitch.maxManualCanaryPercent}`,
    `- requireManualApproval: ${report.rolloutSwitch.requireManualApproval}`,
    '',
    '## Checks',
    '',
  ];
  for (const check of report.checks) {
    lines.push(`- [${check.passed ? 'PASS' : 'FAIL'}][${check.severity}] ${check.id}: actual=${check.actual}, expected=${check.expected}`);
  }
  lines.push('');
  lines.push('## Rollback Strategy');
  lines.push('');
  lines.push(`- trigger: ${report.rollbackStrategy.trigger}`);
  lines.push(`- immediateAction: ${report.rollbackStrategy.immediateAction}`);
  lines.push('- preserveArtifacts:');
  for (const artifact of report.rollbackStrategy.preserveArtifacts) lines.push(`  - ${artifact}`);
  lines.push('- investigation:');
  for (const step of report.rollbackStrategy.investigation) lines.push(`  - ${step}`);
  lines.push('');
  lines.push('> This migration gate is shadow-only. It defines CI/manual gate policy but does not change runtime prompt output.');
  return lines.join('\n');
}

function loadPromptContextMigrationGate(projectRoot) {
  const gatePath = path.join(projectRoot || process.cwd(), 'output', 'prompt-context-migration-gate.json');
  try {
    if (!fs.existsSync(gatePath)) {
      return { exists: false, source: gatePath, gate: null, error: 'prompt-context-migration-gate.json not found' };
    }
    return { exists: true, source: gatePath, gate: JSON.parse(fs.readFileSync(gatePath, 'utf-8')), error: null };
  } catch (err) {
    return { exists: false, source: gatePath, gate: null, error: err.message };
  }
}

function buildPromptContextMigrationCheck({ projectRoot, gate, sourcePath } = {}) {
  const actualProjectRoot = path.resolve(projectRoot || process.cwd());
  const loaded = gate ? { exists: true, source: sourcePath || 'provided', gate, error: null } : loadPromptContextMigrationGate(actualProjectRoot);
  const migrationGate = loaded.gate || {};
  const summary = migrationGate.summary || {};
  const checks = [
    {
      id: 'migration-gate-artifact-readable',
      passed: loaded.exists && !loaded.error,
      actual: loaded.error || 'readable',
      expected: 'readable JSON artifact',
      severity: 'critical',
    },
    {
      id: 'changed-prompt-output-false',
      passed: migrationGate.changedPromptOutput === false,
      actual: migrationGate.changedPromptOutput,
      expected: false,
      severity: 'critical',
    },
    {
      id: 'migration-gate-passed',
      passed: summary.gatePassed === true,
      actual: summary.gatePassed,
      expected: true,
      severity: 'critical',
    },
    {
      id: 'rollback-not-required',
      passed: summary.shouldRollback === false,
      actual: summary.shouldRollback,
      expected: false,
      severity: 'critical',
    },
    {
      id: 'manual-canary-allowed',
      passed: summary.canProceedToManualCanary === true,
      actual: summary.canProceedToManualCanary,
      expected: true,
      severity: 'high',
    },
    {
      id: 'safe-default-runtime',
      passed: migrationGate.rolloutSwitch?.safeDefault === 'PROMPT_CONTEXT_ASSEMBLER_MODE=runtime',
      actual: migrationGate.rolloutSwitch?.safeDefault || null,
      expected: 'PROMPT_CONTEXT_ASSEMBLER_MODE=runtime',
      severity: 'high',
    },
  ];
  const failed = checks.filter(check => !check.passed);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'migration-check-shadow',
    changedPromptOutput: false,
    source: loaded.source ? rel(actualProjectRoot, loaded.source) : null,
    summary: {
      passed: failed.length === 0,
      ciExitCode: failed.length === 0 ? 0 : 1,
      checksPassed: checks.length - failed.length,
      checksTotal: checks.length,
      failedChecks: failed.length,
      highOrCriticalFailures: failed.filter(check => check.severity === 'critical' || check.severity === 'high').length,
      migrationAllowed: summary.migrationAllowed === true,
      canProceedToManualCanary: summary.canProceedToManualCanary === true,
    },
    checks,
    failed,
    recommendation: failed.length === 0
      ? 'CI/manual check may proceed. Keep default runtime mode unless a separate runtime migration is explicitly approved.'
      : 'Block CI/manual migration. Re-run prompt-context-migration-gate and inspect failed checks before proceeding.',
  };
}

function formatMigrationCheckReport(report) {
  const lines = [
    '# PromptContextAssembler CI/Manual Migration Check',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| passed | ${report.summary.passed} |`,
    `| ciExitCode | ${report.summary.ciExitCode} |`,
    `| checksPassed | ${report.summary.checksPassed}/${report.summary.checksTotal} |`,
    `| canProceedToManualCanary | ${report.summary.canProceedToManualCanary} |`,
    `| migrationAllowed | ${report.summary.migrationAllowed} |`,
    '',
    '## Checks',
    '',
  ];
  for (const check of report.checks) {
    lines.push(`- [${check.passed ? 'PASS' : 'FAIL'}][${check.severity}] ${check.id}: actual=${check.actual}, expected=${check.expected}`);
  }
  lines.push('');
  lines.push(`## Recommendation\n\n${report.recommendation}`);
  lines.push('');
  lines.push('> This check is shadow-only. It consumes migration-gate artifacts and does not change prompt output.');
  return lines.join('\n');
}

function classifyP3PromptBuilder(fileRel, normalized, options = {}) {
  const evidence = String(normalized || '');
  const agentSubclass = /^workflow\/agents\/(?!base-agent\.js$)[^/]+-agent\.js$/.test(fileRel) && /buildPrompt\s*\(/.test(evidence);
  if (options.hasGatewayNearby || options.fileHasGateway) {
    return {
      kind: 'caller-covered-runtime-builder',
      runtimeBuilder: true,
      exception: true,
      exceptionReason: options.hasGatewayNearby
        ? 'Prompt builder is consumed next to an LLMInjectionGateway/prepareGatewayPrompt call site.'
        : 'Prompt builder lives in a module whose LLM send points are routed through prepareGatewayPrompt.',
      recommendedAction: 'Keep builder unchanged; verify caller shadow evidence in readiness gate.',
    };
  }
  if (/workflow\/core\/code-review-agent\.js$/.test(fileRel)) {
    return {
      kind: 'caller-covered-runtime-builder',
      runtimeBuilder: true,
      exception: true,
      exceptionReason: 'CodeReviewAgent prompt builders are consumed by ReviewAgentBase, whose runReview/fix/adversarial calls are routed through prepareGatewayPrompt.',
      recommendedAction: 'Keep subclass builders unchanged; keep ReviewAgentBase as the injection boundary.',
    };
  }
  if (/workflow\/core\/session-signal-detector\.js$/.test(fileRel)) {
    return {
      kind: 'caller-covered-runtime-builder',
      runtimeBuilder: true,
      exception: true,
      exceptionReason: 'Session signal extraction prompts are consumed by teardown callers already routed through LLMInjectionGateway shadow path.',
      recommendedAction: 'Keep detector as builder-only; verify teardown caller coverage.',
    };
  }
  if (/workflow\/core\/deep-audit-(?:experts|orchestrator)\.js$/.test(fileRel)) {
    return {
      kind: 'non-runtime-builder',
      runtimeBuilder: false,
      exception: true,
      exceptionReason: 'Deep audit expert review prompts are advisory/report helpers and are not direct runtime LLM send points in this path.',
      recommendedAction: 'Keep as documented P3 exception unless a direct LLM caller is introduced.',
    };
  }
  if (agentSubclass) {
    return {
      kind: 'caller-covered-runtime-builder',
      runtimeBuilder: true,
      exception: true,
      exceptionReason: 'Agent subclass buildPrompt() returns a prompt that BaseAgent.run routes through LLMInjectionGateway.',
      recommendedAction: 'Do not wrap subclass builders directly; keep BaseAgent.run as the runtime injection boundary.',
    };
  }
  if (/workflow\/core\/prompt-builder\.js$/.test(fileRel) || /workflow\/core\/prompt-context-(?:assembler|degradation|registry|selector)/.test(fileRel)) {
    return {
      kind: 'shared-runtime-builder',
      runtimeBuilder: true,
      exception: true,
      exceptionReason: 'Shared builder/helper is not itself an LLM call site; runtime send points are gated separately.',
      recommendedAction: 'Track with readiness gate and prompt parity checks; do not mutate output here.',
    };
  }
  if (/prompts\.js$|prompt-template|agent-generator|schema|formatter|report|inventory|policy|contract|config|budget|cache|digest|loader/.test(fileRel)) {
    return {
      kind: 'non-runtime-builder',
      runtimeBuilder: false,
      exception: true,
      exceptionReason: 'Builder creates templates, generated files, reports, or config fragments rather than sending runtime LLM payloads.',
      recommendedAction: 'Keep as documented P3 exception unless a direct LLM consumer is added.',
    };
  }
  if (/build[A-Za-z0-9_]*Prompt\s*\(/.test(evidence)) {
    return {
      kind: 'remaining-runtime-builder',
      runtimeBuilder: true,
      exception: false,
      exceptionReason: null,
      recommendedAction: 'Review caller path; either document caller coverage or route the send point through LLMInjectionGateway.',
    };
  }
  return {
    kind: 'non-runtime-builder',
    runtimeBuilder: false,
    exception: true,
    exceptionReason: 'Prompt-like expression is not classified as a runtime LLM send point.',
    recommendedAction: 'Keep as inventory-only documented exception.',
  };
}

function buildP3PromptBuilderGovernance(callSites) {
  const p3PromptBuilders = callSites.filter(site => site.priority === 'P3' && site.category === 'prompt-builder-function');
  const exceptions = p3PromptBuilders
    .filter(site => site.p3Governance && site.p3Governance.exception)
    .map(site => ({
      file: site.file,
      line: site.line,
      kind: site.p3Governance.kind,
      runtimeBuilder: site.p3Governance.runtimeBuilder,
      reason: site.p3Governance.exceptionReason,
      recommendedAction: site.p3Governance.recommendedAction,
      evidence: site.evidence,
    }));
  const remainingMigrationMatrix = p3PromptBuilders
    .filter(site => !site.p3Governance || !site.p3Governance.exception)
    .map(site => ({
      file: site.file,
      line: site.line,
      kind: site.p3Governance ? site.p3Governance.kind : 'unclassified',
      runtimeBuilder: site.p3Governance ? site.p3Governance.runtimeBuilder : true,
      evidence: site.evidence,
      targetUnifiedPath: 'Document caller coverage or route the runtime send point through LLMInjectionGateway shadow path.',
    }));
  const byKind = {};
  for (const site of p3PromptBuilders) {
    const kind = site.p3Governance ? site.p3Governance.kind : 'unclassified';
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  return {
    totalPromptBuilders: p3PromptBuilders.length,
    documentedExceptions: exceptions.length,
    remainingRuntimeBuilders: remainingMigrationMatrix.length,
    runtimeBuilders: p3PromptBuilders.filter(site => site.p3Governance && site.p3Governance.runtimeBuilder).length,
    nonRuntimeBuilders: p3PromptBuilders.filter(site => site.p3Governance && !site.p3Governance.runtimeBuilder).length,
    byKind,
    exceptions,
    remainingMigrationMatrix,
  };
}

function _classifyLLMCallSite(fileRel, line, lineNumber, options = {}) {
  const text = String(line || '');
  const normalized = text.trim();
  const isTest = /(^|\/)tests?\//.test(fileRel) || /\.test\.js$/.test(fileRel);
  const category = (() => {
    if (/buildAgentPrompt\s*\(/.test(text)) return 'unified-prompt-builder';
    if (/\.llm\.chat\s*\(/.test(text)) return 'direct-chat-api';
    if (/_rawLlmCall\s*\(/.test(text)) return 'raw-orchestrator-call';
    if (/this\.llmCall\s*\(/.test(text) || /agent\.llmCall\s*\(/.test(text)) return 'agent-adapter-call';
    if (/_llmCall\s*\(/.test(text) || /cheapLlmCall\s*\(/.test(text) || /_cheapLlmCall\s*\(/.test(text) || /_semanticLlmCall\s*\(/.test(text) || /effectiveLlmCall\s*\(/.test(text)) return 'llm-lite-call';
    if (/llmCall\s*\(/.test(text)) return 'injected-llm-call';
    if (/chat\/completions|axios\.post\s*\(/.test(text)) return 'external-provider-call';
    if (/build[A-Za-z0-9_]*Prompt\s*\(/.test(text)) return 'prompt-builder-function';
    return 'prompt-related';
  })();
  const coveredByUnifiedInjection = category === 'unified-prompt-builder'
    || options.hasGatewayNearby === true
    || (category === 'agent-adapter-call' && /workflow\/agents\/base-agent\.js$/.test(fileRel))
    || (category === 'prompt-builder-function' && /workflow\/agents\/base-agent\.js$/.test(fileRel));
  const priority = (() => {
    if (isTest) return 'P3';
    if (/workflow\/index\.js$/.test(fileRel) || /workflow\/agents\/base-agent\.js$/.test(fileRel)) return 'P0';
    if (category === 'direct-chat-api' || category === 'external-provider-call') return 'P0';
    if (category === 'raw-orchestrator-call' || category === 'agent-adapter-call') return 'P1';
    if (category === 'llm-lite-call' || category === 'injected-llm-call') return 'P2';
    return 'P3';
  })();
  const p3Governance = priority === 'P3' && category === 'prompt-builder-function'
    ? classifyP3PromptBuilder(fileRel, normalized, options)
    : null;
  const status = coveredByUnifiedInjection
    ? 'covered-or-routed'
    : p3Governance && p3Governance.exception
      ? 'documented-exception'
      : 'legacy-direct-or-partial';
  return {
    id: sha256(`${fileRel}:${lineNumber}:${normalized}`).slice(0, 16),
    file: fileRel,
    line: lineNumber,
    category,
    priority,
    coveredByUnifiedInjection,
    governedByUnifiedInjection: coveredByUnifiedInjection || status === 'documented-exception',
    status,
    evidence: normalized.slice(0, 240),
    ...(p3Governance ? { p3Governance } : {}),
  };
}

function buildUnifiedLLMInjectionCallSiteInventory({ projectRoot } = {}) {
  const actualProjectRoot = path.resolve(projectRoot || process.cwd());
  const workflowDir = path.join(actualProjectRoot, 'workflow');
  const files = collectFiles(workflowDir, (abs, name) => name.endsWith('.js') && !/\.test\.js$/.test(name));
  const callSites = [];
  const seen = new Set();
  const llmPattern = /buildAgentPrompt\s*\(|\.llm\.chat\s*\(|_rawLlmCall\s*\(|\b(?:this\.)?llmCall\s*\(|agent\.llmCall\s*\(|_llmCall\s*\(|cheapLlmCall\s*\(|_cheapLlmCall\s*\(|_semanticLlmCall\s*\(|effectiveLlmCall\s*\(|chat\/completions|axios\.post\s*\(|build[A-Za-z0-9_]*Prompt\s*\(/;
  for (const filePath of files) {
    const fileRel = rel(actualProjectRoot, filePath);
    if (/workflow\/tests?\//.test(fileRel) || /workflow\/examples\//.test(fileRel)) continue;
    const lines = safeRead(filePath).split(/\r?\n/);
    const gatewayLines = lines
      .map((line, index) => (/LLMInjectionGateway|llmInjectionGateway|prepareGatewayPrompt|prepareTaskLLMChatPayload|prepareAutoDispatchPrompt|initLlmInjectionGateway\.prepare/.test(line) ? index + 1 : null))
      .filter(Boolean);
    lines.forEach((line, index) => {
      const trimmed = String(line || '').trim();
      if (/^(\/\/|\/\*|\*)/.test(trimmed)) return;
      if (/\bllmCall\s*\(\s*\)/.test(trimmed)) return;
      if (/step\d+\s*:.*llmCall\(prompt\)/.test(trimmed)) return;
      if (!llmPattern.test(line)) return;
      const lineNumber = index + 1;
      const hasGatewayNearby = gatewayLines.some(gatewayLine => Math.abs(gatewayLine - lineNumber) <= 18);
      const site = _classifyLLMCallSite(fileRel, line, lineNumber, { hasGatewayNearby, fileHasGateway: gatewayLines.length > 0 });
      const key = `${site.file}:${site.line}:${site.category}`;
      if (seen.has(key)) return;
      seen.add(key);
      callSites.push(site);
    });
  }
  const byCategory = {};
  const byPriority = {};
  const byStatus = {};
  for (const site of callSites) {
    byCategory[site.category] = (byCategory[site.category] || 0) + 1;
    byPriority[site.priority] = (byPriority[site.priority] || 0) + 1;
    byStatus[site.status] = (byStatus[site.status] || 0) + 1;
  }
  const covered = callSites.filter(site => site.coveredByUnifiedInjection).length;
  const governed = callSites.filter(site => site.governedByUnifiedInjection).length;
  const legacyOrPartial = callSites.filter(site => site.status === 'legacy-direct-or-partial').length;
  const documentedExceptions = callSites.filter(site => site.status === 'documented-exception').length;
  const p3PromptBuilderGovernance = buildP3PromptBuilderGovernance(callSites);
  const migrationMatrix = callSites.map(site => ({
    file: site.file,
    line: site.line,
    category: site.category,
    priority: site.priority,
    currentPath: site.coveredByUnifiedInjection
      ? 'LLMInjectionGateway routed call site'
      : site.status === 'documented-exception'
        ? `documented P3 exception: ${site.p3Governance?.kind || 'exception'}`
        : 'legacy direct LLM call or unresolved prompt builder',
    targetUnifiedPath: site.status === 'documented-exception'
      ? site.p3Governance?.recommendedAction || 'Document exception and keep runtime send point gated.'
      : site.priority === 'P0'
        ? 'LLMInjectionGateway required'
        : 'LLMInjectionGateway or documented exception required',
    status: site.status,
  }));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'call-site-inventory-shadow',
    changedPromptOutput: false,
    summary: {
      totalCallSites: callSites.length,
      coveredByUnifiedInjection: covered,
      governedByUnifiedInjection: governed,
      documentedExceptions,
      legacyOrPartialCallSites: legacyOrPartial,
      coverageRate: callSites.length ? Number((covered / callSites.length).toFixed(4)) : 1,
      governanceRate: callSites.length ? Number((governed / callSites.length).toFixed(4)) : 1,
      byCategory,
      byPriority,
      byStatus,
    },
    callSites,
    migrationMatrix,
    p3PromptBuilderGovernance,
    recommendations: [
      'Keep PromptContextAssembler default mode at runtime until CI/manual gate and canary evidence remain stable.',
      'Migrate P0 call sites first: workflow/index.js, BaseAgent, direct chat/API calls, and task orchestrator paths.',
      'Treat LLM-lite maintenance calls as documented exceptions unless they must receive full workflow context.',
    ],
  };
}

function formatUnifiedLLMInjectionCallSiteReport(report) {
  const lines = [
    '# Unified LLM Injection Call-Site Inventory',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| totalCallSites | ${report.summary.totalCallSites} |`,
    `| coveredByUnifiedInjection | ${report.summary.coveredByUnifiedInjection} |`,
    `| governedByUnifiedInjection | ${report.summary.governedByUnifiedInjection || report.summary.coveredByUnifiedInjection} |`,
    `| documentedExceptions | ${report.summary.documentedExceptions || 0} |`,
    `| legacyOrPartialCallSites | ${report.summary.legacyOrPartialCallSites} |`,
    `| coverageRate | ${report.summary.coverageRate} |`,
    `| governanceRate | ${report.summary.governanceRate || report.summary.coverageRate} |`,
    '',
    '## Priority Summary',
    '',
    ...Object.entries(report.summary.byPriority).map(([priority, count]) => `- ${priority}: ${count}`),
    '',
    '## Migration Matrix',
    '',
    '| Priority | Status | Category | Location | Target |',
    '|---|---|---|---|---|',
  ];
  for (const site of report.migrationMatrix.slice(0, 80)) {
    lines.push(`| ${site.priority} | ${site.status} | ${site.category} | \`${site.file}:${site.line}\` | ${site.targetUnifiedPath} |`);
  }
  if (report.migrationMatrix.length > 80) lines.push(`| ... | ... | ... | ... | ${report.migrationMatrix.length - 80} more call site(s) |`);
  lines.push('');
  if (report.p3PromptBuilderGovernance) {
    lines.push('## P3 Prompt Builder Governance');
    lines.push('');
    lines.push(`- totalPromptBuilders: ${report.p3PromptBuilderGovernance.totalPromptBuilders}`);
    lines.push(`- documentedExceptions: ${report.p3PromptBuilderGovernance.documentedExceptions}`);
    lines.push(`- remainingRuntimeBuilders: ${report.p3PromptBuilderGovernance.remainingRuntimeBuilders}`);
    lines.push('');
    lines.push('### Exception List');
    lines.push('');
    for (const item of report.p3PromptBuilderGovernance.exceptions.slice(0, 40)) {
      lines.push(`- \`${item.file}:${item.line}\` — ${item.kind} — ${item.reason}`);
    }
    if (report.p3PromptBuilderGovernance.exceptions.length > 40) lines.push(`- ... ${report.p3PromptBuilderGovernance.exceptions.length - 40} more exception(s)`);
    lines.push('');
    lines.push('### Remaining Runtime Builder Matrix');
    lines.push('');
    if (report.p3PromptBuilderGovernance.remainingMigrationMatrix.length === 0) lines.push('_No unresolved P3 runtime builders._');
    for (const item of report.p3PromptBuilderGovernance.remainingMigrationMatrix.slice(0, 40)) {
      lines.push(`- \`${item.file}:${item.line}\` — ${item.kind} — ${item.targetUnifiedPath}`);
    }
    if (report.p3PromptBuilderGovernance.remainingMigrationMatrix.length > 40) lines.push(`- ... ${report.p3PromptBuilderGovernance.remainingMigrationMatrix.length - 40} more unresolved builder(s)`);
    lines.push('');
  }
  lines.push('## Recommendations');
  lines.push('');
  for (const item of report.recommendations) lines.push(`- ${item}`);
  lines.push('');
  lines.push('> This inventory is shadow-only. It scans prompt/LLM call sites but does not change prompt output.');
  return lines.join('\n');
}

function formatDualWriteCanaryReport(report) {
  const lines = [
    '# PromptContextAssembler Dual-Write Canary',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| payloadCount | ${report.summary.payloadCount} |`,
    `| averageRuntimeTokenCoverage | ${report.summary.averageRuntimeTokenCoverage} |`,
    `| averageJaccardSimilarity | ${report.summary.averageJaccardSimilarity} |`,
    `| rollbackGatePassed | ${report.summary.rollbackGatePassed} |`,
    `| shouldRollback | ${report.summary.shouldRollback} |`,
    '',
    '## Role Payload Diff',
    '',
  ];
  for (const payload of report.payloads) {
    lines.push(`### ${payload.stage}/${payload.role}`);
    lines.push(`- runtimeHash: ${payload.runtime.hash}`);
    lines.push(`- candidateHash: ${payload.candidate.hash}`);
    lines.push(`- runtimeLength: ${payload.runtime.length}`);
    lines.push(`- candidateLength: ${payload.candidate.length}`);
    lines.push(`- runtimeTokenCoverage: ${payload.diff.runtimeTokenCoverage}`);
    lines.push(`- jaccardSimilarity: ${payload.diff.jaccardSimilarity}`);
    lines.push(`- runtimeOnlyTop: ${payload.diff.runtimeOnlyTop.slice(0, 12).join(', ') || '(none)'}`);
    lines.push(`- candidateOnlyTop: ${payload.diff.candidateOnlyTop.slice(0, 12).join(', ') || '(none)'}`);
    if (payload.runtime.error) lines.push(`- runtimeError: ${payload.runtime.error}`);
    lines.push('');
  }
  lines.push('## Rollback Gate');
  lines.push('');
  lines.push(`- passed: ${report.rollbackGate.passed}`);
  lines.push(`- shouldRollback: ${report.rollbackGate.shouldRollback}`);
  lines.push(`- passedChecks: ${report.rollbackGate.summary.passedChecks}/${report.rollbackGate.summary.totalChecks}`);
  for (const failure of report.rollbackGate.failed) {
    lines.push(`- [${failure.severity}] ${failure.id}: actual=${failure.actual}, expected=${failure.expected}`);
  }
  lines.push('');
  lines.push('> This canary is shadow-only. It records runtime and candidate payloads but does not replace ContextLoader, buildAgentPrompt, workflow-stage, or runtime prompt output.');
  return lines.join('\n');
}

function formatFullPromptParityReport(report) {
  const lines = [
    '# PromptContextAssembler Full Prompt Shadow Parity',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| rolesCompared | ${report.summary.rolesCompared} |`,
    `| candidatePromptCount | ${report.summary.candidatePromptCount} |`,
    `| averageRuntimeTokenCoverage | ${report.summary.averageRuntimeTokenCoverage} |`,
    `| averageJaccardSimilarity | ${report.summary.averageJaccardSimilarity} |`,
    `| totalCandidateLength | ${report.summary.totalCandidateLength} |`,
    `| totalRuntimeLength | ${report.summary.totalRuntimeLength} |`,
    '',
    '## Role Parity',
    '',
  ];
  for (const item of report.roleDiffs) {
    lines.push(`### ${item.stage}/${item.role}`);
    lines.push(`- runtimePromptLength: ${item.runtimePromptLength}`);
    lines.push(`- candidatePromptLength: ${item.candidatePromptLength}`);
    lines.push(`- contextSections: ${item.contextSections}`);
    lines.push(`- runtimeTokenCoverage: ${item.runtimeTokenCoverage}`);
    lines.push(`- jaccardSimilarity: ${item.jaccardSimilarity}`);
    lines.push(`- runtimeOnlyTop: ${item.comparison.runtimeOnlyTop.slice(0, 12).join(', ') || '(none)'}`);
    lines.push(`- candidateOnlyTop: ${item.comparison.candidateOnlyTop.slice(0, 12).join(', ') || '(none)'}`);
    if (item.runtimeError) lines.push(`- runtimeError: ${item.runtimeError}`);
    lines.push('');
  }
  lines.push('> This full prompt parity report is shadow-only. It does not replace ContextLoader, buildAgentPrompt, workflow-stage, or any runtime prompt output.');
  return lines.join('\n');
}

function formatSelectionBudgetReport(report) {
  const lines = [
    '# PromptContextRegistry Selection Budget',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| rolesCompared | ${report.summary.rolesCompared} |`,
    `| selectedBlocks | ${report.summary.selectedBlocks} |`,
    `| selectedEstimatedTokens | ${report.summary.selectedEstimatedTokens} |`,
    `| omittedBlocks | ${report.summary.omittedBlocks} |`,
    `| driftAlertCount | ${report.summary.driftAlertCount} |`,
    `| highDriftAlertCount | ${report.summary.highDriftAlertCount} |`,
    '',
    '## Role Budgets',
    '',
  ];
  for (const roleBudget of report.roleBudgets) {
    lines.push(`### ${roleBudget.stage}/${roleBudget.role}`);
    lines.push(`- selectedBlocks: ${roleBudget.selectedBlocks}/${roleBudget.budget.maxBlocks}`);
    lines.push(`- selectedEstimatedTokens: ${roleBudget.selectedEstimatedTokens}/${roleBudget.budget.maxTokens}`);
    lines.push(`- omittedBlocks: ${roleBudget.omittedBlocks}`);
    for (const block of roleBudget.blocks) {
      lines.push(`  - ${block.blockId} — ${block.type} — tokens=${block.tokenEstimate} — score=${block.matchScore}`);
    }
    lines.push('');
  }
  lines.push('## Drift Alerts');
  lines.push('');
  if (report.driftAlerts.length === 0) lines.push('_No drift alerts._');
  for (const alert of report.driftAlerts.slice(0, 40)) {
    lines.push(`- [${alert.severity}] ${alert.type}: ${alert.message}`);
  }
  lines.push('');
  lines.push('> This selection budget is shadow-only. It does not replace ContextLoader, buildAgentPrompt, workflow-stage, or any runtime prompt output.');
  return lines.join('\n');
}

async function resolveContextLoaderSnapshots(projectRoot, requirement) {
  const ContextLoader = require('./context-loader').ContextLoader || require('./context-loader');
  const configPath = path.join(projectRoot, 'workflow.config.js');
  let config = {};
  try {
    delete require.cache[require.resolve(configPath)];
    if (fs.existsSync(configPath)) config = require(configPath);
  } catch { config = {}; }

  const loader = new ContextLoader({
    workflowRoot: path.join(projectRoot, 'workflow'),
    projectRoot,
    skillKeywords: config.skillKeywords || {},
    alwaysLoadSkills: config.alwaysLoadSkills || [],
    globalSkills: config.globalSkills || [],
    projectSkills: config.projectSkills || [],
    registeredSkills: config.builtinSkills || [],
  });
  const stageRoles = [
    ['ANALYSE', 'analyst'],
    ['ARCHITECT', 'architect'],
    ['PLAN', 'planner'],
    ['DEVELOP', 'developer'],
    ['TEST', 'test-report'],
  ];
  const contexts = [];
  for (const [stage, role] of stageRoles) {
    const resolved = await loader.resolve(requirement || 'PromptContextAssembler dynamic context shadow diff', role, { stage });
    const sources = resolved.sources || [];
    contexts.push({
      stage,
      role,
      taskText: requirement || '',
      tokenCount: resolved.tokenCount || 0,
      sources,
      sections: (resolved.sections || []).map((content, index) => ({
        index,
        source: sources[index] || 'unknown',
        content,
      })),
    });
  }
  return contexts;
}

function formatDuplicateReport(report) {
  const lines = [
    '# PromptContextBlock Duplicate Report',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| totalBlocks | ${report.summary.totalBlocks} |`,
    `| exactDuplicateGroups | ${report.summary.exactDuplicateGroups} |`,
    `| normalizedDuplicateGroups | ${report.summary.normalizedDuplicateGroups} |`,
    `| nearDuplicatePairs | ${report.summary.nearDuplicatePairs} |`,
    `| duplicateBlockCount | ${report.summary.duplicateBlockCount} |`,
    '',
    '## Normalized Duplicate Groups',
    '',
  ];

  if (report.normalizedDuplicates.length === 0) lines.push('_No normalized duplicate groups found._');
  for (const group of report.normalizedDuplicates.slice(0, 20)) {
    lines.push(`### ${group.hash.slice(0, 12)} (${group.count} blocks)`);
    for (const block of group.blocks) lines.push(`- \`${block.id}\` — ${block.source || '(unknown source)'}`);
    lines.push('');
  }

  lines.push('## Near Duplicate Candidates');
  lines.push('');
  if (report.nearDuplicateCandidates.length === 0) lines.push('_No near duplicate candidates found._');
  for (const pair of report.nearDuplicateCandidates.slice(0, 20)) {
    lines.push(`- score=${pair.score}: \`${pair.blocks[0].id}\` ↔ \`${pair.blocks[1].id}\``);
  }
  lines.push('');
  lines.push('> This report is shadow-only. It does not change existing prompt assembly or LLM output.');
  return lines.join('\n');
}

function buildPromptContextInventory(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const collector = createCollector(projectRoot);

  scanStaticSourceFiles({ collector, projectRoot });
  scanContextLoaderMandatoryDocs({ collector, projectRoot, filePath: path.join(projectRoot, 'workflow/core/context-loader-config.js') });
  scanSkills({ collector, projectRoot });
  scanContextDigests({ collector, projectRoot });

  const stageContextPath = path.join(projectRoot, 'output', 'stage-context.json');
  if (fs.existsSync(stageContextPath)) {
    collector.addBlock({
      id: 'stage-context.current',
      type: 'stage-context',
      owner: 'StageContextStore',
      source: rel(projectRoot, stageContextPath),
      sourcePath: stageContextPath,
      priority: 80,
      dedupePolicy: 'exact',
      content: safeRead(stageContextPath),
    });
  }

  const blocks = collector.blocks.sort((a, b) => a.id.localeCompare(b.id));
  const byType = {};
  const byOwner = {};
  for (const block of blocks) {
    byType[block.type] = (byType[block.type] || 0) + 1;
    byOwner[block.owner] = (byOwner[block.owner] || 0) + 1;
  }

  const duplicateReport = buildDuplicateReport(blocks);
  const inventory = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    mode: 'shadow-only',
    changedPromptOutput: false,
    projectRoot,
    summary: {
      totalBlocks: blocks.length,
      totalEstimatedTokens: blocks.reduce((sum, b) => sum + b.tokenEstimate, 0),
      totalChars: blocks.reduce((sum, b) => sum + b.charCount, 0),
      byType,
      byOwner,
      duplicateSummary: duplicateReport.summary,
    },
    blocks,
  };

  return { inventory, duplicateReport, duplicateMarkdown: formatDuplicateReport(duplicateReport) };
}

function writePromptContextInventory(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const result = buildPromptContextInventory({ projectRoot });
  const inventoryPath = path.join(outputDir, 'prompt-context-inventory.json');
  const duplicatesPath = path.join(outputDir, 'prompt-context-duplicates.json');
  const duplicatesMarkdownPath = path.join(outputDir, 'prompt-context-duplicates.md');
  fs.writeFileSync(inventoryPath, JSON.stringify(result.inventory, null, 2), 'utf-8');
  fs.writeFileSync(duplicatesPath, JSON.stringify(result.duplicateReport, null, 2), 'utf-8');
  fs.writeFileSync(duplicatesMarkdownPath, result.duplicateMarkdown, 'utf-8');
  return {
    ...result,
    paths: {
      inventory: inventoryPath,
      duplicates: duplicatesPath,
      duplicatesMarkdown: duplicatesMarkdownPath,
    },
  };
}

function writePromptContextDuplicateGovernance(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const inventoryResult = writePromptContextInventory({ projectRoot });
  const governance = buildPromptContextDuplicateGovernance({
    inventory: inventoryResult.inventory,
    duplicateReport: inventoryResult.duplicateReport,
  });
  const governancePath = path.join(outputDir, 'prompt-context-duplicate-governance.json');
  const allowlistPath = path.join(outputDir, 'prompt-context-duplicate-allowlist.json');
  const mergeSuggestionsPath = path.join(outputDir, 'prompt-context-merge-suggestions.json');
  const mergeSuggestionsMarkdownPath = path.join(outputDir, 'prompt-context-merge-suggestions.md');
  fs.writeFileSync(governancePath, JSON.stringify(governance, null, 2), 'utf-8');
  fs.writeFileSync(allowlistPath, JSON.stringify(governance.allowlist, null, 2), 'utf-8');
  fs.writeFileSync(mergeSuggestionsPath, JSON.stringify(governance.mergeSuggestions, null, 2), 'utf-8');
  fs.writeFileSync(mergeSuggestionsMarkdownPath, formatMergeSuggestions(governance), 'utf-8');
  return {
    ...inventoryResult,
    governance,
    paths: {
      ...inventoryResult.paths,
      governance: governancePath,
      allowlist: allowlistPath,
      mergeSuggestions: mergeSuggestionsPath,
      mergeSuggestionsMarkdown: mergeSuggestionsMarkdownPath,
    },
  };
}

function writePromptContextRegistry(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const governanceResult = writePromptContextDuplicateGovernance({ projectRoot });
  const registryResult = buildPromptContextRegistry({
    inventory: governanceResult.inventory,
    governance: governanceResult.governance,
  });
  const registryPath = path.join(outputDir, 'prompt-context-registry.json');
  const shadowAssemblyPath = path.join(outputDir, 'prompt-context-shadow-assembly.json');
  const shadowAssemblyMarkdownPath = path.join(outputDir, 'prompt-context-shadow-assembly.md');
  fs.writeFileSync(registryPath, JSON.stringify(registryResult.registry, null, 2), 'utf-8');
  fs.writeFileSync(shadowAssemblyPath, JSON.stringify(registryResult.shadowAssembly, null, 2), 'utf-8');
  fs.writeFileSync(shadowAssemblyMarkdownPath, formatShadowAssemblyReport(registryResult.shadowAssembly), 'utf-8');
  return {
    ...governanceResult,
    ...registryResult,
    paths: {
      ...governanceResult.paths,
      registry: registryPath,
      shadowAssembly: shadowAssemblyPath,
      shadowAssemblyMarkdown: shadowAssemblyMarkdownPath,
    },
  };
}

function writePromptContextAssemblerShadowDiff(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const registryResult = writePromptContextRegistry({ projectRoot });
  const assemblerDiff = buildPromptContextAssemblerShadowDiff({
    registry: registryResult.registry,
    shadowAssembly: registryResult.shadowAssembly,
  });
  const candidatesPath = path.join(outputDir, 'prompt-context-shadow-candidates.json');
  const diffPath = path.join(outputDir, 'prompt-context-shadow-diff.json');
  const diffMarkdownPath = path.join(outputDir, 'prompt-context-shadow-diff.md');
  fs.writeFileSync(candidatesPath, JSON.stringify(assemblerDiff.candidatePrompts, null, 2), 'utf-8');
  fs.writeFileSync(diffPath, JSON.stringify({ ...assemblerDiff, candidatePrompts: undefined }, null, 2), 'utf-8');
  fs.writeFileSync(diffMarkdownPath, formatAssemblerShadowDiffReport(assemblerDiff), 'utf-8');
  return {
    ...registryResult,
    assemblerDiff,
    paths: {
      ...registryResult.paths,
      shadowCandidates: candidatesPath,
      shadowDiff: diffPath,
      shadowDiffMarkdown: diffMarkdownPath,
    },
  };
}

async function writePromptContextDynamicContextShadowDiff(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const registryResult = writePromptContextRegistry({ projectRoot });
  const injectedContexts = options.injectedContexts || await resolveContextLoaderSnapshots(projectRoot, options.requirement || 'PromptContextAssembler dynamic context shadow diff');
  const dynamicContextDiff = buildPromptContextDynamicContextShadowDiff({
    registry: registryResult.registry,
    injectedContexts,
    projectRoot,
  });
  const injectedPath = path.join(outputDir, 'prompt-context-dynamic-context-injections.json');
  const diffPath = path.join(outputDir, 'prompt-context-dynamic-context-diff.json');
  const diffMarkdownPath = path.join(outputDir, 'prompt-context-dynamic-context-diff.md');
  fs.writeFileSync(injectedPath, JSON.stringify(injectedContexts, null, 2), 'utf-8');
  fs.writeFileSync(diffPath, JSON.stringify(dynamicContextDiff, null, 2), 'utf-8');
  fs.writeFileSync(diffMarkdownPath, formatDynamicContextShadowDiffReport(dynamicContextDiff), 'utf-8');
  return {
    ...registryResult,
    dynamicContextDiff,
    injectedContexts,
    paths: {
      ...registryResult.paths,
      dynamicContextInjections: injectedPath,
      dynamicContextDiff: diffPath,
      dynamicContextDiffMarkdown: diffMarkdownPath,
    },
  };
}

async function writePromptContextSelectionBudget(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const dynamicResult = await writePromptContextDynamicContextShadowDiff({
    projectRoot,
    requirement: options.requirement || 'PromptContextRegistry selection budget',
    injectedContexts: options.injectedContexts,
  });
  const selectionBudget = buildPromptContextSelectionBudget({
    registry: dynamicResult.registry,
    dynamicContextDiff: dynamicResult.dynamicContextDiff,
    budget: options.budget,
  });
  const budgetPath = path.join(outputDir, 'prompt-context-selection-budget.json');
  const budgetMarkdownPath = path.join(outputDir, 'prompt-context-selection-budget.md');
  fs.writeFileSync(budgetPath, JSON.stringify(selectionBudget, null, 2), 'utf-8');
  fs.writeFileSync(budgetMarkdownPath, formatSelectionBudgetReport(selectionBudget), 'utf-8');
  return {
    ...dynamicResult,
    selectionBudget,
    paths: {
      ...dynamicResult.paths,
      selectionBudget: budgetPath,
      selectionBudgetMarkdown: budgetMarkdownPath,
    },
  };
}

async function writePromptContextFullPromptShadowParity(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const budgetResult = await writePromptContextSelectionBudget({
    projectRoot,
    requirement: options.requirement || 'PromptContextAssembler full prompt shadow parity',
    injectedContexts: options.injectedContexts,
  });
  const contexts = options.contexts || await resolveFullPromptContextSnapshots(projectRoot, options.requirement || 'PromptContextAssembler full prompt shadow parity');
  const fullPromptParity = await buildPromptContextFullPromptShadowParity({
    projectRoot,
    requirement: options.requirement || 'PromptContextAssembler full prompt shadow parity',
    contexts,
  });
  const candidatesPath = path.join(outputDir, 'prompt-context-full-shadow-candidates.json');
  const parityPath = path.join(outputDir, 'prompt-context-full-shadow-parity.json');
  const parityMarkdownPath = path.join(outputDir, 'prompt-context-full-shadow-parity.md');
  fs.writeFileSync(candidatesPath, JSON.stringify(fullPromptParity.candidatePrompts, null, 2), 'utf-8');
  fs.writeFileSync(parityPath, JSON.stringify({ ...fullPromptParity, candidatePrompts: undefined, runtimePrompts: undefined }, null, 2), 'utf-8');
  fs.writeFileSync(parityMarkdownPath, formatFullPromptParityReport(fullPromptParity), 'utf-8');
  return {
    ...budgetResult,
    fullPromptParity,
    paths: {
      ...budgetResult.paths,
      fullShadowCandidates: candidatesPath,
      fullShadowParity: parityPath,
      fullShadowParityMarkdown: parityMarkdownPath,
    },
  };
}

async function writePromptContextDualWriteCanary(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const parityResult = await writePromptContextFullPromptShadowParity({
    projectRoot,
    requirement: options.requirement || 'PromptContextAssembler dual-write canary',
    contexts: options.contexts,
    injectedContexts: options.injectedContexts,
  });
  const dualWriteCanary = await buildPromptContextDualWriteCanary({
    projectRoot,
    requirement: options.requirement || 'PromptContextAssembler dual-write canary',
    contexts: options.contexts,
    thresholds: options.thresholds,
  });
  const payloadsPath = path.join(outputDir, 'prompt-context-dual-write-payloads.json');
  const canaryPath = path.join(outputDir, 'prompt-context-dual-write-canary.json');
  const canaryMarkdownPath = path.join(outputDir, 'prompt-context-dual-write-canary.md');
  const rollbackGatePath = path.join(outputDir, 'prompt-context-dual-write-rollback-gate.json');
  fs.writeFileSync(payloadsPath, JSON.stringify(dualWriteCanary.payloads, null, 2), 'utf-8');
  fs.writeFileSync(canaryPath, JSON.stringify({ ...dualWriteCanary, payloads: undefined }, null, 2), 'utf-8');
  fs.writeFileSync(canaryMarkdownPath, formatDualWriteCanaryReport(dualWriteCanary), 'utf-8');
  fs.writeFileSync(rollbackGatePath, JSON.stringify(dualWriteCanary.rollbackGate, null, 2), 'utf-8');
  return {
    ...parityResult,
    dualWriteCanary,
    paths: {
      ...parityResult.paths,
      dualWritePayloads: payloadsPath,
      dualWriteCanary: canaryPath,
      dualWriteCanaryMarkdown: canaryMarkdownPath,
      dualWriteRollbackGate: rollbackGatePath,
    },
  };
}

async function writePromptContextMigrationGate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const canaryResult = await writePromptContextDualWriteCanary({
    projectRoot,
    requirement: options.requirement || 'PromptContextAssembler migration gate',
    contexts: options.contexts,
    injectedContexts: options.injectedContexts,
    thresholds: options.thresholds,
  });
  const migrationGate = buildPromptContextMigrationGate(canaryResult.dualWriteCanary, { policy: options.policy });
  const migrationGatePath = path.join(outputDir, 'prompt-context-migration-gate.json');
  const migrationGateMarkdownPath = path.join(outputDir, 'prompt-context-migration-gate.md');
  const rolloutPolicyPath = path.join(outputDir, 'prompt-context-migration-rollout-policy.json');
  fs.writeFileSync(migrationGatePath, JSON.stringify(migrationGate, null, 2), 'utf-8');
  fs.writeFileSync(migrationGateMarkdownPath, formatMigrationGateReport(migrationGate), 'utf-8');
  fs.writeFileSync(rolloutPolicyPath, JSON.stringify({
    mode: migrationGate.mode,
    rolloutSwitch: migrationGate.rolloutSwitch,
    rollbackStrategy: migrationGate.rollbackStrategy,
    changedPromptOutput: migrationGate.changedPromptOutput,
  }, null, 2), 'utf-8');
  return {
    ...canaryResult,
    migrationGate,
    paths: {
      ...canaryResult.paths,
      migrationGate: migrationGatePath,
      migrationGateMarkdown: migrationGateMarkdownPath,
      migrationRolloutPolicy: rolloutPolicyPath,
    },
  };
}

function writePromptContextMigrationCheck(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const migrationCheck = buildPromptContextMigrationCheck({ projectRoot, gate: options.gate, sourcePath: options.sourcePath });
  const checkPath = path.join(outputDir, 'prompt-context-migration-check.json');
  const checkMarkdownPath = path.join(outputDir, 'prompt-context-migration-check.md');
  fs.writeFileSync(checkPath, JSON.stringify(migrationCheck, null, 2), 'utf-8');
  fs.writeFileSync(checkMarkdownPath, formatMigrationCheckReport(migrationCheck), 'utf-8');
  return {
    migrationCheck,
    paths: {
      migrationCheck: checkPath,
      migrationCheckMarkdown: checkMarkdownPath,
    },
  };
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

function readShadowTelemetry(projectRoot) {
  const filePath = path.join(projectRoot, 'output', 'unified-llm-injection-shadow.jsonl');
  if (!fs.existsSync(filePath)) return { exists: false, records: [], parseErrors: ['shadow artifact not found'], path: filePath };
  const records = [];
  const parseErrors = [];
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean);
  lines.forEach((line, index) => {
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      parseErrors.push(`line ${index + 1}: ${err.message}`);
    }
  });
  return { exists: true, records, parseErrors, path: filePath };
}

function findPromptLeakage(records) {
  const forbiddenKeys = new Set(['prompt', 'prompts', 'messages', 'message', 'content', 'system', 'user', 'assistant', 'rawPrompt', 'runtimePrompt', 'candidatePrompt']);
  const findings = [];
  function visit(value, pathParts, recordIndex) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) {
        findings.push({ recordIndex, path: [...pathParts, key].join('.'), key });
      }
      if (child && typeof child === 'object') visit(child, [...pathParts, key], recordIndex);
    }
  }
  records.forEach((record, index) => visit(record, ['record'], index));
  return findings;
}

function buildPriorityCoverage(callSites, priorities = ['P0', 'P1', 'P2']) {
  const result = {};
  for (const priority of priorities) {
    const sites = callSites.filter(site => site.priority === priority);
    const covered = sites.filter(site => site.coveredByUnifiedInjection).length;
    result[priority] = {
      total: sites.length,
      covered,
      legacy: sites.length - covered,
      passed: sites.length > 0 && covered === sites.length,
    };
  }
  return result;
}

function buildUnifiedLLMInjectionRuntimeReadinessGate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const inventory = options.inventory || buildUnifiedLLMInjectionCallSiteInventory({ projectRoot });
  const shadow = readShadowTelemetry(projectRoot);
  const leakageFindings = findPromptLeakage(shadow.records);
  const migrationGate = readJsonArtifact(projectRoot, 'output/prompt-context-migration-gate.json');
  const migrationCheck = readJsonArtifact(projectRoot, 'output/prompt-context-migration-check.json');
  const completionContract = options.ignoreCompletionContract
    ? { exists: true, path: path.join(projectRoot, 'output', 'completion-contract-result.json'), value: { passed: true, skippedForCIGate: true }, error: null }
    : readJsonArtifact(projectRoot, 'output/completion-contract-result.json');
  const testProof = readJsonArtifact(projectRoot, 'output/test-execution-proof.json');
  const priorityCoverage = buildPriorityCoverage(inventory.callSites || []);
  const consecutiveGateEvidence = [
    { id: 'migration-gate', passed: migrationGate.value?.summary?.gatePassed === true, source: 'output/prompt-context-migration-gate.json' },
    { id: 'migration-check', passed: migrationCheck.value?.summary?.passed === true, source: 'output/prompt-context-migration-check.json' },
    { id: 'completion-contract', passed: completionContract.value?.passed === true, source: 'output/completion-contract-result.json' },
    { id: 'test-proof', passed: testProof.value?.success === true || testProof.value?.passed === true || testProof.value?.summary?.passed === true, source: 'output/test-execution-proof.json' },
  ];
  const rollbackSignal = migrationGate.value?.summary?.shouldRollback === true
    || migrationCheck.value?.summary?.highOrCriticalFailures > 0
    || completionContract.value?.passed === false;
  const checks = [
    { id: 'changed-prompt-output-false', passed: inventory.changedPromptOutput === false, actual: inventory.changedPromptOutput, expected: false, severity: 'critical' },
    { id: 'p0-shadow-coverage', passed: priorityCoverage.P0.passed, actual: `${priorityCoverage.P0.covered}/${priorityCoverage.P0.total}`, expected: 'all P0 covered', severity: 'critical' },
    { id: 'p1-shadow-coverage', passed: priorityCoverage.P1.passed, actual: `${priorityCoverage.P1.covered}/${priorityCoverage.P1.total}`, expected: 'all P1 covered', severity: 'critical' },
    { id: 'p2-shadow-coverage', passed: priorityCoverage.P2.passed, actual: `${priorityCoverage.P2.covered}/${priorityCoverage.P2.total}`, expected: 'all P2 covered', severity: 'critical' },
    { id: 'shadow-artifact-readable', passed: shadow.exists && shadow.parseErrors.length === 0 && shadow.records.length > 0, actual: shadow.exists ? `${shadow.records.length} record(s), ${shadow.parseErrors.length} parse error(s)` : 'missing', expected: 'readable JSONL with >=1 record', severity: 'high' },
    { id: 'no-prompt-leakage', passed: leakageFindings.length === 0, actual: leakageFindings.length, expected: 0, severity: 'critical' },
    { id: 'migration-gate-passed', passed: migrationGate.value?.summary?.gatePassed === true, actual: migrationGate.value?.summary?.gatePassed, expected: true, severity: 'critical' },
    { id: 'migration-check-passed', passed: migrationCheck.value?.summary?.passed === true, actual: migrationCheck.value?.summary?.passed, expected: true, severity: 'critical' },
    { id: 'completion-contract-passed', passed: completionContract.value?.passed === true, actual: completionContract.value?.passed, expected: true, severity: 'high' },
    { id: 'no-rollback-signal', passed: rollbackSignal === false, actual: rollbackSignal, expected: false, severity: 'critical' },
    { id: 'p3-governance-produced', passed: !!inventory.p3PromptBuilderGovernance, actual: !!inventory.p3PromptBuilderGovernance, expected: true, severity: 'medium' },
  ];
  const failed = checks.filter(check => !check.passed);
  const gatePassed = failed.filter(check => check.severity === 'critical' || check.severity === 'high').length === 0;
  const consecutiveGatePassed = consecutiveGateEvidence.every(item => item.passed === true);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'unified-llm-injection-runtime-readiness-shadow',
    changedPromptOutput: false,
    summary: {
      gatePassed,
      candidateRuntimeAllowed: gatePassed && consecutiveGatePassed,
      consecutiveGatePassed,
      checksPassed: checks.length - failed.length,
      checksTotal: checks.length,
      failedChecks: failed.length,
      highOrCriticalFailures: failed.filter(check => check.severity === 'critical' || check.severity === 'high').length,
      promptLeakageFindings: leakageFindings.length,
      rollbackSignal,
    },
    priorityCoverage,
    shadowEvidence: {
      source: rel(projectRoot, shadow.path),
      exists: shadow.exists,
      recordCount: shadow.records.length,
      parseErrors: shadow.parseErrors,
    },
    consecutiveGateEvidence,
    promptLeakage: leakageFindings,
    p3PromptBuilderGovernance: inventory.p3PromptBuilderGovernance || null,
    checks,
    failed,
    rolloutPolicy: {
      defaultGatewayMode: 'WF_LLM_INJECTION_GATEWAY_MODE=shadow',
      defaultAssemblerMode: 'PROMPT_CONTEXT_ASSEMBLER_MODE=runtime',
      candidateGatewayMode: 'WF_LLM_INJECTION_GATEWAY_MODE=candidate-runtime',
      requireManualApproval: true,
      candidateRuntimeAllowedOnlyWhen: 'summary.candidateRuntimeAllowed === true and a separate runtime rollout workflow explicitly changes the switch',
    },
    recommendation: gatePassed && consecutiveGatePassed
      ? 'Readiness evidence is sufficient for a separate manual candidate-runtime canary workflow. This command does not change runtime output.'
      : 'Do not enable candidate runtime. Keep shadow/default runtime modes and resolve failed readiness checks first.',
  };
}

function formatUnifiedLLMInjectionRuntimeReadinessReport(report) {
  const lines = [
    '# Unified LLM Injection Runtime Readiness Gate',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| gatePassed | ${report.summary.gatePassed} |`,
    `| candidateRuntimeAllowed | ${report.summary.candidateRuntimeAllowed} |`,
    `| consecutiveGatePassed | ${report.summary.consecutiveGatePassed} |`,
    `| promptLeakageFindings | ${report.summary.promptLeakageFindings} |`,
    `| rollbackSignal | ${report.summary.rollbackSignal} |`,
    `| checksPassed | ${report.summary.checksPassed}/${report.summary.checksTotal} |`,
    '',
    '## Priority Coverage',
    '',
  ];
  for (const [priority, coverage] of Object.entries(report.priorityCoverage)) {
    lines.push(`- ${priority}: ${coverage.covered}/${coverage.total} covered, legacy=${coverage.legacy}, passed=${coverage.passed}`);
  }
  lines.push('', '## Checks', '');
  for (const check of report.checks) {
    lines.push(`- [${check.passed ? 'PASS' : 'FAIL'}][${check.severity}] ${check.id}: actual=${check.actual}, expected=${check.expected}`);
  }
  lines.push('', '## Consecutive Gate Evidence', '');
  for (const item of report.consecutiveGateEvidence) lines.push(`- [${item.passed ? 'PASS' : 'FAIL'}] ${item.id}: ${item.source}`);
  lines.push('', '## Prompt Leakage Findings', '');
  if (report.promptLeakage.length === 0) lines.push('_No prompt leakage findings._');
  for (const finding of report.promptLeakage.slice(0, 40)) lines.push(`- record=${finding.recordIndex} path=${finding.path} key=${finding.key}`);
  lines.push('', '## P3 Remaining Runtime Builder Matrix', '');
  const remaining = report.p3PromptBuilderGovernance?.remainingMigrationMatrix || [];
  if (remaining.length === 0) lines.push('_No unresolved P3 runtime builders._');
  for (const item of remaining.slice(0, 40)) lines.push(`- \`${item.file}:${item.line}\` — ${item.kind} — ${item.targetUnifiedPath}`);
  lines.push('', '## Recommendation', '', report.recommendation, '');
  lines.push('> This readiness gate is shadow-only. It does not change runtime prompt output or environment switches.');
  return lines.join('\n');
}

function buildUnifiedLLMInjectionCandidateRuntimeCanary(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const readiness = options.readinessGate || readJsonArtifact(projectRoot, 'output/unified-llm-injection-runtime-readiness-gate.json').value || buildUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot });
  const inventory = options.inventory || buildUnifiedLLMInjectionCallSiteInventory({ projectRoot });
  const approved = options.approved === true || String(options.approved || '').toLowerCase() === 'true';
  const lowRiskSites = (inventory.callSites || [])
    .filter(site => site.coveredByUnifiedInjection && /^(llm-lite-call|injected-llm-call)$/.test(site.category))
    .map(site => site.evidence && site.evidence.includes('prepareGatewayPrompt') ? site.file : `${site.file}:${site.line}`);
  const allowlist = [...new Set(options.allowlist || lowRiskSites)].slice(0, 80);
  const sloGate = {
    promptLeakageFindings: readiness.summary?.promptLeakageFindings || 0,
    rollbackSignal: readiness.summary?.rollbackSignal === true,
    highOrCriticalFailures: readiness.summary?.highOrCriticalFailures || 0,
    readinessGatePassed: readiness.summary?.gatePassed === true,
    consecutiveGatePassed: readiness.summary?.consecutiveGatePassed === true,
    passed: (readiness.summary?.promptLeakageFindings || 0) === 0
      && readiness.summary?.rollbackSignal !== true
      && (readiness.summary?.highOrCriticalFailures || 0) === 0
      && readiness.summary?.gatePassed === true
      && readiness.summary?.consecutiveGatePassed === true,
  };
  const canaryActivationReady = approved && allowlist.length > 0 && sloGate.passed === true;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'candidate-runtime-canary-policy',
    changedPromptOutput: false,
    summary: {
      readinessCandidateRuntimeAllowed: readiness.summary?.candidateRuntimeAllowed === true,
      manualApproved: approved,
      lowRiskAllowlistCount: allowlist.length,
      sloGatePassed: sloGate.passed,
      canaryActivationReady,
    },
    envSwitches: {
      defaultSafeMode: 'WF_LLM_INJECTION_GATEWAY_MODE=shadow',
      candidateMode: 'WF_LLM_INJECTION_GATEWAY_MODE=candidate-runtime',
      approval: 'WF_LLM_INJECTION_CANARY_APPROVED=true',
      allowlist: `WF_LLM_INJECTION_CANARY_ALLOWLIST=${allowlist.join(',')}`,
      percent: `WF_LLM_INJECTION_CANARY_PERCENT=${Number(options.percent || 1)}`,
      rollback: 'WF_LLM_INJECTION_CANARY_ROLLBACK=true',
    },
    lowRiskAllowlist: allowlist,
    sloGate,
    rollbackPolicy: {
      trigger: 'Any prompt leakage, rollback signal, high/critical failure, operator complaint, or SLO breach.',
      immediateAction: 'Set WF_LLM_INJECTION_CANARY_ROLLBACK=true or WF_LLM_INJECTION_GATEWAY_MODE=shadow.',
      preserveArtifacts: [
        'output/unified-llm-injection-candidate-runtime-canary.json',
        'output/unified-llm-injection-shadow.jsonl',
        'output/unified-llm-injection-runtime-readiness-gate.json',
      ],
    },
    recommendation: canaryActivationReady
      ? 'Manual approval and SLO gate are satisfied. Candidate runtime may be enabled only for the allowlisted low-risk paths and configured percentage.'
      : 'Do not enable candidate runtime yet. Review approval, allowlist, and SLO gate before setting candidate env switches.',
  };
}

function formatUnifiedLLMInjectionCandidateRuntimeCanaryReport(report) {
  const lines = [
    '# Unified LLM Injection Candidate Runtime Canary',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| readinessCandidateRuntimeAllowed | ${report.summary.readinessCandidateRuntimeAllowed} |`,
    `| manualApproved | ${report.summary.manualApproved} |`,
    `| lowRiskAllowlistCount | ${report.summary.lowRiskAllowlistCount} |`,
    `| sloGatePassed | ${report.summary.sloGatePassed} |`,
    `| canaryActivationReady | ${report.summary.canaryActivationReady} |`,
    '',
    '## Env Switches',
    '',
  ];
  for (const [key, value] of Object.entries(report.envSwitches)) lines.push(`- ${key}: \`${value}\``);
  lines.push('', '## SLO Gate', '');
  for (const [key, value] of Object.entries(report.sloGate)) lines.push(`- ${key}: ${value}`);
  lines.push('', '## Low-risk Allowlist', '');
  for (const item of report.lowRiskAllowlist.slice(0, 60)) lines.push(`- \`${item}\``);
  if (report.lowRiskAllowlist.length > 60) lines.push(`- ... ${report.lowRiskAllowlist.length - 60} more item(s)`);
  lines.push('', '## Rollback Policy', '');
  lines.push(`- trigger: ${report.rollbackPolicy.trigger}`);
  lines.push(`- immediateAction: ${report.rollbackPolicy.immediateAction}`);
  lines.push('', '## Recommendation', '', report.recommendation, '');
  lines.push('> This canary policy is reporting/configuration-only. It does not mutate environment variables or default prompt output.');
  return lines.join('\n');
}

function writeUnifiedLLMInjectionCandidateRuntimeCanary(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const readinessResult = writeUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot, ignoreCompletionContract: options.ignoreCompletionContract === true });
  const canary = buildUnifiedLLMInjectionCandidateRuntimeCanary({
    projectRoot,
    inventory: readinessResult.callSiteInventory,
    readinessGate: readinessResult.readinessGate,
    approved: options.approved,
    allowlist: options.allowlist,
    percent: options.percent,
  });
  const canaryPath = path.join(outputDir, 'unified-llm-injection-candidate-runtime-canary.json');
  const canaryMarkdownPath = path.join(outputDir, 'unified-llm-injection-candidate-runtime-canary.md');
  fs.writeFileSync(canaryPath, JSON.stringify(canary, null, 2), 'utf-8');
  fs.writeFileSync(canaryMarkdownPath, formatUnifiedLLMInjectionCandidateRuntimeCanaryReport(canary), 'utf-8');
  return {
    ...readinessResult,
    canary,
    paths: {
      ...readinessResult.paths,
      unifiedLLMInjectionCandidateRuntimeCanary: canaryPath,
      unifiedLLMInjectionCandidateRuntimeCanaryMarkdown: canaryMarkdownPath,
    },
  };
}

function buildUnifiedLLMInjectionDefaultRuntimeReplacement(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const readiness = options.readinessGate || readJsonArtifact(projectRoot, 'output/unified-llm-injection-runtime-readiness-gate.json').value || buildUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot });
  const canary = options.canary || readJsonArtifact(projectRoot, 'output/unified-llm-injection-candidate-runtime-canary.json').value || buildUnifiedLLMInjectionCandidateRuntimeCanary({ projectRoot, approved: true, percent: 100 });
  const promptLeakageFindings = readiness.summary?.promptLeakageFindings || canary.sloGate?.promptLeakageFindings || 0;
  const rollbackSignal = readiness.summary?.rollbackSignal === true || canary.sloGate?.rollbackSignal === true;
  const sloGatePassed = canary.sloGate?.passed === true && promptLeakageFindings === 0 && rollbackSignal === false;
  const readinessGatePassed = readiness.summary?.gatePassed === true && readiness.summary?.candidateRuntimeAllowed === true;
  const canaryActivationReady = canary.summary?.canaryActivationReady === true || (canary.summary?.sloGatePassed === true && canary.summary?.manualApproved === true);
  const defaultReplacementActive = readinessGatePassed && canaryActivationReady && sloGatePassed;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'default-runtime-replacement',
    changedPromptOutput: defaultReplacementActive,
    summary: {
      defaultReplacementActive,
      defaultGatewayMode: 'candidate-runtime',
      defaultAssemblerMode: 'candidate-runtime',
      readinessGatePassed,
      canaryActivationReady,
      sloGatePassed,
      promptLeakageFindings,
      rollbackSignal,
    },
    defaultRuntimePolicy: {
      gatewayDefault: 'WF_LLM_INJECTION_GATEWAY_MODE=candidate-runtime',
      assemblerDefault: 'PROMPT_CONTEXT_ASSEMBLER_MODE=candidate-runtime',
      gatewayControlsFinalSendDecision: true,
      governedCategories: [
        'agent-wrapper',
        'agent-adapter-call',
        'raw-orchestrator-call',
        'direct-chat-api',
        'external-provider-call',
        'llm-lite-call',
        'injected-llm-call',
        'verification',
      ],
    },
    rollbackPolicy: {
      gatewayRollback: 'WF_LLM_INJECTION_GATEWAY_MODE=shadow',
      emergencyRollback: 'WF_LLM_INJECTION_CANARY_ROLLBACK=true',
      assemblerRollback: 'PROMPT_CONTEXT_ASSEMBLER_MODE=runtime',
      trigger: 'Any prompt leakage, rollback signal, high/critical failure, operator complaint, latency/error SLO breach, or prompt quality regression.',
    },
    evidence: {
      readinessGate: 'output/unified-llm-injection-runtime-readiness-gate.json',
      canaryPolicy: 'output/unified-llm-injection-candidate-runtime-canary.json',
      shadowTelemetry: 'output/unified-llm-injection-shadow.jsonl',
    },
    recommendation: defaultReplacementActive
      ? 'Default runtime replacement is active. Keep rollback switches available and continue monitoring prompt leakage, rollback signals, latency, and quality drift.'
      : 'Default runtime replacement is not safe to activate. Keep rollback/runtime mode until readiness and canary SLO evidence pass.',
  };
}

function formatUnifiedLLMInjectionDefaultRuntimeReplacementReport(report) {
  const lines = [
    '# Unified LLM Injection Default Runtime Replacement',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| changedPromptOutput | ${report.changedPromptOutput} |`,
    `| defaultReplacementActive | ${report.summary.defaultReplacementActive} |`,
    `| defaultGatewayMode | ${report.summary.defaultGatewayMode} |`,
    `| defaultAssemblerMode | ${report.summary.defaultAssemblerMode} |`,
    `| readinessGatePassed | ${report.summary.readinessGatePassed} |`,
    `| canaryActivationReady | ${report.summary.canaryActivationReady} |`,
    `| sloGatePassed | ${report.summary.sloGatePassed} |`,
    `| promptLeakageFindings | ${report.summary.promptLeakageFindings} |`,
    `| rollbackSignal | ${report.summary.rollbackSignal} |`,
    '',
    '## Default Runtime Policy',
    '',
    `- gatewayDefault: \`${report.defaultRuntimePolicy.gatewayDefault}\``,
    `- assemblerDefault: \`${report.defaultRuntimePolicy.assemblerDefault}\``,
    `- gatewayControlsFinalSendDecision: ${report.defaultRuntimePolicy.gatewayControlsFinalSendDecision}`,
    `- governedCategories: ${report.defaultRuntimePolicy.governedCategories.join(', ')}`,
    '',
    '## Rollback Policy',
    '',
    `- gatewayRollback: \`${report.rollbackPolicy.gatewayRollback}\``,
    `- emergencyRollback: \`${report.rollbackPolicy.emergencyRollback}\``,
    `- assemblerRollback: \`${report.rollbackPolicy.assemblerRollback}\``,
    `- trigger: ${report.rollbackPolicy.trigger}`,
    '',
    '## Evidence',
    '',
  ];
  for (const [key, value] of Object.entries(report.evidence)) lines.push(`- ${key}: \`${value}\``);
  lines.push('', '## Recommendation', '', report.recommendation, '');
  lines.push('> Default replacement is now the default runtime policy; rollback switches remain explicit and immediate.');
  return lines.join('\n');
}

function writeUnifiedLLMInjectionDefaultRuntimeReplacement(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const readinessResult = writeUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot, ignoreCompletionContract: options.ignoreCompletionContract === true });
  const canaryResult = writeUnifiedLLMInjectionCandidateRuntimeCanary({ projectRoot, approved: true, percent: 100, ignoreCompletionContract: options.ignoreCompletionContract === true });
  const defaultReplacement = buildUnifiedLLMInjectionDefaultRuntimeReplacement({
    projectRoot,
    readinessGate: readinessResult.readinessGate,
    canary: canaryResult.canary,
  });
  const defaultReplacementPath = path.join(outputDir, 'unified-llm-injection-default-runtime-replacement.json');
  const defaultReplacementMarkdownPath = path.join(outputDir, 'unified-llm-injection-default-runtime-replacement.md');
  fs.writeFileSync(defaultReplacementPath, JSON.stringify(defaultReplacement, null, 2), 'utf-8');
  fs.writeFileSync(defaultReplacementMarkdownPath, formatUnifiedLLMInjectionDefaultRuntimeReplacementReport(defaultReplacement), 'utf-8');
  return {
    ...canaryResult,
    readinessGate: readinessResult.readinessGate,
    defaultReplacement,
    paths: {
      ...canaryResult.paths,
      unifiedLLMInjectionRuntimeReadinessGate: readinessResult.paths.unifiedLLMInjectionRuntimeReadinessGate,
      unifiedLLMInjectionRuntimeReadinessGateMarkdown: readinessResult.paths.unifiedLLMInjectionRuntimeReadinessGateMarkdown,
      unifiedLLMInjectionDefaultRuntimeReplacement: defaultReplacementPath,
      unifiedLLMInjectionDefaultRuntimeReplacementMarkdown: defaultReplacementMarkdownPath,
    },
  };
}

function buildUnifiedLLMInjectionCIGate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const inventory = options.inventory || buildUnifiedLLMInjectionCallSiteInventory({ projectRoot });
  const readiness = options.readinessGate || readJsonArtifact(projectRoot, 'output/unified-llm-injection-runtime-readiness-gate.json').value || buildUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot, inventory });
  const defaultReplacement = options.defaultReplacement || readJsonArtifact(projectRoot, 'output/unified-llm-injection-default-runtime-replacement.json').value || buildUnifiedLLMInjectionDefaultRuntimeReplacement({ projectRoot, readinessGate: readiness });
  const p3Remaining = inventory.p3PromptBuilderGovernance?.remainingRuntimeBuilders ?? 0;
  const legacyOrPartial = inventory.summary?.legacyOrPartialCallSites ?? 0;
  const promptLeakageFindings = readiness.summary?.promptLeakageFindings ?? defaultReplacement.summary?.promptLeakageFindings ?? 0;
  const rollbackSignal = readiness.summary?.rollbackSignal === true || defaultReplacement.summary?.rollbackSignal === true;
  const priorityCoverage = readiness.priorityCoverage || buildPriorityCoverage(inventory.callSites || []);
  const checks = [
    { id: 'default-replacement-active', passed: defaultReplacement.summary?.defaultReplacementActive === true, actual: defaultReplacement.summary?.defaultReplacementActive, expected: true, severity: 'critical' },
    { id: 'readiness-gate-passed', passed: readiness.summary?.gatePassed === true && readiness.summary?.candidateRuntimeAllowed === true, actual: readiness.summary?.gatePassed, expected: 'gatePassed=true and candidateRuntimeAllowed=true', severity: 'critical' },
    { id: 'p0-no-legacy', passed: priorityCoverage.P0?.legacy === 0 && priorityCoverage.P0?.passed === true, actual: priorityCoverage.P0?.legacy, expected: 0, severity: 'critical' },
    { id: 'p1-no-legacy', passed: priorityCoverage.P1?.legacy === 0 && priorityCoverage.P1?.passed === true, actual: priorityCoverage.P1?.legacy, expected: 0, severity: 'critical' },
    { id: 'p2-no-legacy', passed: priorityCoverage.P2?.legacy === 0 && priorityCoverage.P2?.passed === true, actual: priorityCoverage.P2?.legacy, expected: 0, severity: 'critical' },
    { id: 'no-legacy-or-partial-call-sites', passed: legacyOrPartial === 0, actual: legacyOrPartial, expected: 0, severity: 'critical' },
    { id: 'p3-no-remaining-runtime-builders', passed: p3Remaining === 0, actual: p3Remaining, expected: 0, severity: 'critical' },
    { id: 'no-prompt-leakage', passed: promptLeakageFindings === 0, actual: promptLeakageFindings, expected: 0, severity: 'critical' },
    { id: 'no-rollback-signal', passed: rollbackSignal === false, actual: rollbackSignal, expected: false, severity: 'critical' },
    { id: 'rollback-policy-present', passed: !!defaultReplacement.rollbackPolicy?.gatewayRollback && !!defaultReplacement.rollbackPolicy?.assemblerRollback, actual: !!defaultReplacement.rollbackPolicy, expected: true, severity: 'high' },
  ];
  const failed = checks.filter(check => !check.passed);
  const blockingFailures = failed.filter(check => check.severity === 'critical' || check.severity === 'high');
  const passed = blockingFailures.length === 0;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'unified-llm-injection-ci-gate',
    changedPromptOutput: false,
    summary: {
      passed,
      checksPassed: checks.length - failed.length,
      checksTotal: checks.length,
      failedChecks: failed.length,
      blockingFailures: blockingFailures.length,
      defaultReplacementActive: defaultReplacement.summary?.defaultReplacementActive === true,
      legacyOrPartialCallSites: legacyOrPartial,
      p3RemainingRuntimeBuilders: p3Remaining,
      promptLeakageFindings,
      rollbackSignal,
    },
    priorityCoverage,
    checks,
    failed,
    artifacts: {
      inventory: 'output/unified-llm-injection-call-site-inventory.json',
      readinessGate: 'output/unified-llm-injection-runtime-readiness-gate.json',
      defaultReplacement: 'output/unified-llm-injection-default-runtime-replacement.json',
    },
    ciCommand: 'npm run ci:llm-injection',
    recommendation: passed
      ? 'CI gate passed. Unified LLM Injection is enforced against new legacy call sites, prompt leakage, P3 remaining builders, and rollback signals.'
      : 'CI gate failed. Block merge and inspect failed checks before proceeding.',
  };
}

function formatUnifiedLLMInjectionCIGateReport(report) {
  const lines = [
    '# Unified LLM Injection CI Gate',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| passed | ${report.summary.passed} |`,
    `| checksPassed | ${report.summary.checksPassed}/${report.summary.checksTotal} |`,
    `| blockingFailures | ${report.summary.blockingFailures} |`,
    `| defaultReplacementActive | ${report.summary.defaultReplacementActive} |`,
    `| legacyOrPartialCallSites | ${report.summary.legacyOrPartialCallSites} |`,
    `| p3RemainingRuntimeBuilders | ${report.summary.p3RemainingRuntimeBuilders} |`,
    `| promptLeakageFindings | ${report.summary.promptLeakageFindings} |`,
    `| rollbackSignal | ${report.summary.rollbackSignal} |`,
    '',
    '## Checks',
    '',
  ];
  for (const check of report.checks) {
    lines.push(`- [${check.passed ? 'PASS' : 'FAIL'}][${check.severity}] ${check.id}: actual=${check.actual}, expected=${check.expected}`);
  }
  lines.push('', '## Failed Checks', '');
  if (report.failed.length === 0) lines.push('_No failed checks._');
  for (const check of report.failed) lines.push(`- ${check.id}: actual=${check.actual}, expected=${check.expected}`);
  lines.push('', '## CI Command', '', `\`${report.ciCommand}\``, '', '## Artifacts', '');
  for (const [key, value] of Object.entries(report.artifacts)) lines.push(`- ${key}: \`${value}\``);
  lines.push('', '## Recommendation', '', report.recommendation, '');
  return lines.join('\n');
}

function writeUnifiedLLMInjectionCIGate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const defaultResult = writeUnifiedLLMInjectionDefaultRuntimeReplacement({ projectRoot, ignoreCompletionContract: true });
  const ciGate = buildUnifiedLLMInjectionCIGate({
    projectRoot,
    inventory: defaultResult.callSiteInventory,
    readinessGate: defaultResult.readinessGate,
    defaultReplacement: defaultResult.defaultReplacement,
  });
  const ciGatePath = path.join(outputDir, 'unified-llm-injection-ci-gate.json');
  const ciGateMarkdownPath = path.join(outputDir, 'unified-llm-injection-ci-gate.md');
  fs.writeFileSync(ciGatePath, JSON.stringify(ciGate, null, 2), 'utf-8');
  fs.writeFileSync(ciGateMarkdownPath, formatUnifiedLLMInjectionCIGateReport(ciGate), 'utf-8');
  return {
    ...defaultResult,
    ciGate,
    paths: {
      ...defaultResult.paths,
      unifiedLLMInjectionCIGate: ciGatePath,
      unifiedLLMInjectionCIGateMarkdown: ciGateMarkdownPath,
    },
  };
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

function inferTelemetryError(record) {
  const explicit = readPathValue(record, ['error', 'metadata.error', 'metrics.error']);
  if (explicit === true) return { known: true, failed: true };
  if (explicit === false) return { known: true, failed: false };
  const success = readPathValue(record, ['success', 'metadata.success', 'metrics.success']);
  if (success === true) return { known: true, failed: false };
  if (success === false) return { known: true, failed: true };
  const status = String(readPathValue(record, ['status', 'metadata.status', 'metrics.status']) || '').toLowerCase();
  if (status) return { known: true, failed: /fail|error|timeout|reject/.test(status) };
  return { known: false, failed: false };
}

function extractLatencyPair(record) {
  const runtime = asFiniteNumber(readPathValue(record, [
    'runtime.latencyMs',
    'metrics.runtimeLatencyMs',
    'metadata.runtimeLatencyMs',
    'metadata.latencyRuntimeMs',
  ]));
  const candidate = asFiniteNumber(readPathValue(record, [
    'candidate.latencyMs',
    'metrics.candidateLatencyMs',
    'metadata.candidateLatencyMs',
    'metadata.latencyCandidateMs',
  ]));
  if (runtime == null || candidate == null || runtime <= 0) return null;
  return { runtime, candidate, deltaPercent: ((candidate - runtime) / runtime) * 100 };
}

function extractQualityDrift(record) {
  const explicit = asFiniteNumber(readPathValue(record, [
    'qualityDriftScore',
    'metrics.qualityDriftScore',
    'metadata.qualityDriftScore',
  ]));
  if (explicit != null) return { score: Math.abs(explicit), source: 'explicit' };
  const runtimeLength = asFiniteNumber(record.runtime?.length);
  const candidateLength = asFiniteNumber(record.candidate?.length);
  if (runtimeLength != null && candidateLength != null && runtimeLength > 0) {
    return { score: Math.abs(candidateLength - runtimeLength) / runtimeLength, source: 'length-delta' };
  }
  return null;
}

function summarizeRuntimeSLO(records, options = {}) {
  const thresholds = {
    maxErrorRate: asFiniteNumber(options.maxErrorRate) ?? 0.01,
    maxLatencyDeltaPercent: asFiniteNumber(options.maxLatencyDeltaPercent) ?? 25,
    maxQualityDriftScore: asFiniteNumber(options.maxQualityDriftScore) ?? 0.2,
  };
  const sampleCount = records.length;
  const errorSignals = records.map(inferTelemetryError);
  const knownErrors = errorSignals.filter(item => item.known);
  const failedErrors = knownErrors.filter(item => item.failed);
  const latencyPairs = records.map(extractLatencyPair).filter(Boolean);
  const qualitySignals = records.map(extractQualityDrift).filter(Boolean);
  const hashMismatches = records.filter(record => record.runtime?.hash && record.candidate?.hash && record.runtime.hash !== record.candidate.hash).length;
  const latencyDeltaPercent = latencyPairs.length
    ? latencyPairs.reduce((sum, item) => sum + item.deltaPercent, 0) / latencyPairs.length
    : null;
  const maxLatencyDeltaPercent = latencyPairs.length
    ? Math.max(...latencyPairs.map(item => item.deltaPercent))
    : null;
  const qualityDriftScore = qualitySignals.length
    ? qualitySignals.reduce((sum, item) => sum + item.score, 0) / qualitySignals.length
    : null;
  const maxQualityDriftScore = qualitySignals.length
    ? Math.max(...qualitySignals.map(item => item.score))
    : null;
  return {
    thresholds,
    sampleCount,
    llmErrorRate: knownErrors.length ? failedErrors.length / knownErrors.length : null,
    errorSamples: knownErrors.length,
    errorCount: failedErrors.length,
    latencyDeltaPercent,
    maxLatencyDeltaPercent,
    latencySamples: latencyPairs.length,
    qualityDriftScore,
    maxQualityDriftScore,
    qualitySamples: qualitySignals.length,
    hashMismatchRate: sampleCount ? hashMismatches / sampleCount : null,
    dataCoverage: {
      error: sampleCount ? knownErrors.length / sampleCount : 0,
      latency: sampleCount ? latencyPairs.length / sampleCount : 0,
      quality: sampleCount ? qualitySignals.length / sampleCount : 0,
    },
  };
}

function buildUnifiedLLMInjectionSLODashboard(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const shadow = options.shadow || readShadowTelemetry(projectRoot);
  const records = options.records || shadow.records || [];
  const readiness = options.readinessGate || readJsonArtifact(projectRoot, 'output/unified-llm-injection-runtime-readiness-gate.json').value || {};
  const defaultReplacement = options.defaultReplacement || readJsonArtifact(projectRoot, 'output/unified-llm-injection-default-runtime-replacement.json').value || {};
  const ciGate = options.ciGate || readJsonArtifact(projectRoot, 'output/unified-llm-injection-ci-gate.json').value || {};
  const leakageFindings = findPromptLeakage(records);
  const promptLeakageFindings = Math.max(
    leakageFindings.length,
    readiness.summary?.promptLeakageFindings || 0,
    defaultReplacement.summary?.promptLeakageFindings || 0,
    ciGate.summary?.promptLeakageFindings || 0
  );
  const telemetryRollback = records.some(record => record.canary?.rollback === true || (record.canary?.reasons || []).includes('rollback-active'));
  const rollbackSignal = telemetryRollback
    || readiness.summary?.rollbackSignal === true
    || defaultReplacement.summary?.rollbackSignal === true
    || ciGate.summary?.rollbackSignal === true;
  const slo = summarizeRuntimeSLO(records, options.thresholds || {});
  const defaultReplacementActive = defaultReplacement.summary?.defaultReplacementActive === true;
  const ciGatePassed = ciGate.summary?.passed === true;
  const checks = [
    { id: 'prompt-leakage', severity: 'critical', passed: promptLeakageFindings === 0, actual: promptLeakageFindings, expected: 0 },
    { id: 'rollback-signal', severity: 'critical', passed: rollbackSignal === false, actual: rollbackSignal, expected: false },
    { id: 'default-replacement-active', severity: 'critical', passed: defaultReplacementActive, actual: defaultReplacementActive, expected: true },
    { id: 'ci-gate-passed', severity: 'high', passed: ciGatePassed, actual: ciGatePassed, expected: true },
    { id: 'llm-error-rate', severity: 'high', passed: slo.llmErrorRate == null || slo.llmErrorRate <= slo.thresholds.maxErrorRate, actual: slo.llmErrorRate, expected: `<=${slo.thresholds.maxErrorRate}`, noData: slo.llmErrorRate == null },
    { id: 'latency-delta', severity: 'high', passed: slo.maxLatencyDeltaPercent == null || slo.maxLatencyDeltaPercent <= slo.thresholds.maxLatencyDeltaPercent, actual: slo.maxLatencyDeltaPercent, expected: `<=${slo.thresholds.maxLatencyDeltaPercent}%`, noData: slo.maxLatencyDeltaPercent == null },
    { id: 'quality-drift', severity: 'high', passed: slo.maxQualityDriftScore == null || slo.maxQualityDriftScore <= slo.thresholds.maxQualityDriftScore, actual: slo.maxQualityDriftScore, expected: `<=${slo.thresholds.maxQualityDriftScore}`, noData: slo.maxQualityDriftScore == null },
  ];
  const failed = checks.filter(check => !check.passed);
  const blockingFailures = failed.filter(check => check.severity === 'critical' || check.severity === 'high');
  const noDataChecks = checks.filter(check => check.noData);
  const lowCoverage = Object.entries(slo.dataCoverage).filter(([, value]) => value > 0 && value < 0.8).map(([key, value]) => ({ key, value }));
  const health = blockingFailures.length > 0 ? 'unhealthy' : (noDataChecks.length > 0 || lowCoverage.length > 0 ? 'warning' : 'healthy');
  const releaseReady = health === 'healthy';
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: 'unified-llm-injection-runtime-slo-dashboard',
    changedPromptOutput: false,
    summary: {
      health,
      releaseReady,
      sampleCount: slo.sampleCount,
      defaultReplacementActive,
      ciGatePassed,
      promptLeakageFindings,
      rollbackSignal,
      llmErrorRate: slo.llmErrorRate,
      latencyDeltaPercent: slo.latencyDeltaPercent,
      maxLatencyDeltaPercent: slo.maxLatencyDeltaPercent,
      qualityDriftScore: slo.qualityDriftScore,
      maxQualityDriftScore: slo.maxQualityDriftScore,
      hashMismatchRate: slo.hashMismatchRate,
      blockingFailures: blockingFailures.length,
      warningSignals: noDataChecks.length + lowCoverage.length,
    },
    dataCoverage: slo.dataCoverage,
    thresholds: slo.thresholds,
    checks,
    failed,
    noDataChecks,
    lowCoverage,
    telemetry: {
      source: rel(projectRoot, shadow.path || path.join(projectRoot, 'output', 'unified-llm-injection-shadow.jsonl')),
      exists: shadow.exists !== false,
      parseErrors: shadow.parseErrors || [],
      errorSamples: slo.errorSamples,
      errorCount: slo.errorCount,
      latencySamples: slo.latencySamples,
      qualitySamples: slo.qualitySamples,
    },
    promptLeakage: leakageFindings.slice(0, 40),
    artifacts: {
      readinessGate: 'output/unified-llm-injection-runtime-readiness-gate.json',
      defaultReplacement: 'output/unified-llm-injection-default-runtime-replacement.json',
      ciGate: 'output/unified-llm-injection-ci-gate.json',
      dashboard: 'output/unified-llm-injection-slo-dashboard.json',
      releaseHealthSummary: 'output/unified-llm-injection-release-health-summary.md',
    },
    releaseRecommendation: health === 'healthy'
      ? 'Release health is healthy. Continue default runtime replacement and keep scheduled SLO monitoring active.'
      : health === 'warning'
        ? 'Release health is warning. Continue with caution, improve telemetry coverage, and watch latency/error/quality drift before expanding rollout.'
        : 'Release health is unhealthy. Stop rollout or rollback default runtime replacement, then inspect failed SLO checks.',
  };
}

function formatPercent(value) {
  return value == null ? 'n/a' : `${(value * 100).toFixed(2)}%`;
}

function formatNumber(value, digits = 2) {
  return value == null ? 'n/a' : Number(value).toFixed(digits);
}

function formatUnifiedLLMInjectionSLODashboardReport(report) {
  const lines = [
    '# Unified LLM Injection Runtime SLO Dashboard',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| health | ${report.summary.health} |`,
    `| releaseReady | ${report.summary.releaseReady} |`,
    `| sampleCount | ${report.summary.sampleCount} |`,
    `| defaultReplacementActive | ${report.summary.defaultReplacementActive} |`,
    `| ciGatePassed | ${report.summary.ciGatePassed} |`,
    `| promptLeakageFindings | ${report.summary.promptLeakageFindings} |`,
    `| rollbackSignal | ${report.summary.rollbackSignal} |`,
    `| llmErrorRate | ${formatPercent(report.summary.llmErrorRate)} |`,
    `| maxLatencyDeltaPercent | ${formatNumber(report.summary.maxLatencyDeltaPercent)} |`,
    `| maxQualityDriftScore | ${formatNumber(report.summary.maxQualityDriftScore)} |`,
    `| hashMismatchRate | ${formatPercent(report.summary.hashMismatchRate)} |`,
    '',
    '## Data Coverage',
    '',
  ];
  for (const [key, value] of Object.entries(report.dataCoverage)) lines.push(`- ${key}: ${formatPercent(value)}`);
  lines.push('', '## Checks', '');
  for (const check of report.checks) {
    lines.push(`- [${check.passed ? 'PASS' : 'FAIL'}][${check.severity}] ${check.id}: actual=${check.actual == null ? 'n/a' : check.actual}, expected=${check.expected}${check.noData ? ' (no-data)' : ''}`);
  }
  lines.push('', '## Prompt Leakage Findings', '');
  if (report.promptLeakage.length === 0) lines.push('_No prompt leakage findings._');
  for (const finding of report.promptLeakage) lines.push(`- record=${finding.recordIndex} path=${finding.path} key=${finding.key}`);
  lines.push('', '## Recommendation', '', report.releaseRecommendation, '');
  return lines.join('\n');
}

function formatUnifiedLLMInjectionReleaseHealthSummary(report) {
  const lines = [
    '# Unified LLM Injection Release Health Summary',
    '',
    `- Health: **${report.summary.health}**`,
    `- Release ready: **${report.summary.releaseReady}**`,
    `- Default replacement active: ${report.summary.defaultReplacementActive}`,
    `- CI gate passed: ${report.summary.ciGatePassed}`,
    `- Prompt leakage findings: ${report.summary.promptLeakageFindings}`,
    `- Rollback signal: ${report.summary.rollbackSignal}`,
    `- LLM error rate: ${formatPercent(report.summary.llmErrorRate)}`,
    `- Max latency delta: ${formatNumber(report.summary.maxLatencyDeltaPercent)}%`,
    `- Max quality drift score: ${formatNumber(report.summary.maxQualityDriftScore)}`,
    '',
    '## Failed Checks',
    '',
  ];
  if (report.failed.length === 0) lines.push('_No failed checks._');
  for (const check of report.failed) lines.push(`- [${check.severity}] ${check.id}: actual=${check.actual}, expected=${check.expected}`);
  lines.push('', '## No-data / Coverage Warnings', '');
  if (report.noDataChecks.length === 0 && report.lowCoverage.length === 0) lines.push('_No coverage warnings._');
  for (const check of report.noDataChecks) lines.push(`- ${check.id}: no telemetry data available yet.`);
  for (const item of report.lowCoverage) lines.push(`- ${item.key}: coverage=${formatPercent(item.value)}.`);
  lines.push('', '## Recommendation', '', report.releaseRecommendation, '');
  lines.push('## Rollback', '', '- `WF_LLM_INJECTION_GATEWAY_MODE=shadow`', '- `WF_LLM_INJECTION_CANARY_ROLLBACK=true`', '- `PROMPT_CONTEXT_ASSEMBLER_MODE=runtime`', '');
  return lines.join('\n');
}

function writeUnifiedLLMInjectionSLODashboard(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const ciResult = options.skipCIGateRefresh ? null : writeUnifiedLLMInjectionCIGate({ projectRoot });
  const dashboard = buildUnifiedLLMInjectionSLODashboard({
    projectRoot,
    readinessGate: ciResult?.readinessGate,
    defaultReplacement: ciResult?.defaultReplacement,
    ciGate: ciResult?.ciGate,
    thresholds: options.thresholds,
  });
  const dashboardPath = path.join(outputDir, 'unified-llm-injection-slo-dashboard.json');
  const dashboardMarkdownPath = path.join(outputDir, 'unified-llm-injection-slo-dashboard.md');
  const releaseHealthSummaryPath = path.join(outputDir, 'unified-llm-injection-release-health-summary.md');
  fs.writeFileSync(dashboardPath, JSON.stringify(dashboard, null, 2), 'utf-8');
  fs.writeFileSync(dashboardMarkdownPath, formatUnifiedLLMInjectionSLODashboardReport(dashboard), 'utf-8');
  fs.writeFileSync(releaseHealthSummaryPath, formatUnifiedLLMInjectionReleaseHealthSummary(dashboard), 'utf-8');
  const { evaluateSLOAlerts, formatAlertSignals } = require('./slo-alert-evaluator');
  const signals = evaluateSLOAlerts(dashboard);
  const sloAlerts = formatAlertSignals(signals, {
    sloAlertWebhook: options.sloAlertWebhook,
    sloAlertWebhookToken: options.sloAlertWebhookToken,
  });
  const sloAlertsPath = path.join(outputDir, 'slo-alerts.json');
  fs.writeFileSync(sloAlertsPath, JSON.stringify(sloAlerts, null, 2), 'utf-8');
  return {
    ...(ciResult || {}),
    sloDashboard: dashboard,
    sloAlerts,
    paths: {
      ...(ciResult?.paths || {}),
      unifiedLLMInjectionSLODashboard: dashboardPath,
      unifiedLLMInjectionSLODashboardMarkdown: dashboardMarkdownPath,
      unifiedLLMInjectionReleaseHealthSummary: releaseHealthSummaryPath,
      sloAlerts: sloAlertsPath,
    },
  };
}

function writeUnifiedLLMInjectionRuntimeReadinessGate(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const inventoryResult = writeUnifiedLLMInjectionCallSiteInventory({ projectRoot });
  const readinessGate = buildUnifiedLLMInjectionRuntimeReadinessGate({ projectRoot, inventory: inventoryResult.callSiteInventory, ignoreCompletionContract: options.ignoreCompletionContract === true });
  const readinessPath = path.join(outputDir, 'unified-llm-injection-runtime-readiness-gate.json');
  const readinessMarkdownPath = path.join(outputDir, 'unified-llm-injection-runtime-readiness-gate.md');
  fs.writeFileSync(readinessPath, JSON.stringify(readinessGate, null, 2), 'utf-8');
  fs.writeFileSync(readinessMarkdownPath, formatUnifiedLLMInjectionRuntimeReadinessReport(readinessGate), 'utf-8');
  return {
    ...inventoryResult,
    readinessGate,
    paths: {
      ...inventoryResult.paths,
      unifiedLLMInjectionRuntimeReadinessGate: readinessPath,
      unifiedLLMInjectionRuntimeReadinessGateMarkdown: readinessMarkdownPath,
    },
  };
}

function writeUnifiedLLMInjectionCallSiteInventory(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const outputDir = path.join(projectRoot, 'output');
  fs.mkdirSync(outputDir, { recursive: true });
  const callSiteInventory = buildUnifiedLLMInjectionCallSiteInventory({ projectRoot });
  const inventoryPath = path.join(outputDir, 'unified-llm-injection-call-site-inventory.json');
  const inventoryMarkdownPath = path.join(outputDir, 'unified-llm-injection-call-site-inventory.md');
  fs.writeFileSync(inventoryPath, JSON.stringify(callSiteInventory, null, 2), 'utf-8');
  fs.writeFileSync(inventoryMarkdownPath, formatUnifiedLLMInjectionCallSiteReport(callSiteInventory), 'utf-8');
  return {
    callSiteInventory,
    paths: {
      unifiedLLMInjectionCallSiteInventory: inventoryPath,
      unifiedLLMInjectionCallSiteInventoryMarkdown: inventoryMarkdownPath,
    },
  };
}

module.exports = {
  buildPromptContextInventory,
  writePromptContextInventory,
  buildPromptContextDuplicateGovernance,
  writePromptContextDuplicateGovernance,
  buildPromptContextRegistry,
  buildPromptContextShadowAssembly,
  buildPromptContextAssemblerShadowDiff,
  buildPromptContextDynamicContextShadowDiff,
  buildPromptContextSelectionBudget,
  buildPromptContextFullPromptShadowParity,
  buildPromptContextDualWriteCanary,
  buildPromptContextMigrationGate,
  buildPromptContextMigrationCheck,
  buildUnifiedLLMInjectionCallSiteInventory,
  buildUnifiedLLMInjectionRuntimeReadinessGate,
  buildUnifiedLLMInjectionCandidateRuntimeCanary,
  buildUnifiedLLMInjectionDefaultRuntimeReplacement,
  buildUnifiedLLMInjectionCIGate,
  buildUnifiedLLMInjectionSLODashboard,
  writePromptContextRegistry,
  writePromptContextAssemblerShadowDiff,
  writePromptContextDynamicContextShadowDiff,
  writePromptContextSelectionBudget,
  writePromptContextFullPromptShadowParity,
  writePromptContextDualWriteCanary,
  writePromptContextMigrationGate,
  writePromptContextMigrationCheck,
  writeUnifiedLLMInjectionCallSiteInventory,
  writeUnifiedLLMInjectionRuntimeReadinessGate,
  writeUnifiedLLMInjectionCandidateRuntimeCanary,
  writeUnifiedLLMInjectionDefaultRuntimeReplacement,
  writeUnifiedLLMInjectionCIGate,
  writeUnifiedLLMInjectionSLODashboard,
  normalizeContent,
  buildDuplicateReport,
};
