
'use strict';

const path = require('path');
const fs = require('fs');
const { collectFiles, safeRead, rel, createCollector, normalizeContent, estimateTokens, sha256, sourceHash } = require('./pci-utils');

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

module.exports = {
  splitMarkdownHeadingBlocks,
  scanMarkdownSections,
  scanRolePrefixes,
  scanContextLoaderConfig,
  scanBridgeInstructionBlocks,
  scanSkills,
  scanContextDigests,
  roleToStage,
  resolveContextLoaderDocPath,
  scanContextLoaderMandatoryDocs,
  scanStaticSourceFiles,
};
