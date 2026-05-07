'use strict';

const fs = require('fs');
const path = require('path');
const { SCHEMA_VERSION, rel, safeRead, createCollector, normalizeContent } = require('./pci-utils');

function scanStaticSourceFiles({ collector, projectRoot }) {
  const coreDir = path.join(projectRoot, 'workflow', 'core');
  if (!fs.existsSync(coreDir)) return;
  for (const entry of fs.readdirSync(coreDir).filter(f => f.endsWith('.js')).sort()) {
    const filePath = path.join(coreDir, entry);
    const content = safeRead(filePath);
    collector.addBlock({
      id: `static-source.core.${entry}`,
      type: 'static-source',
      owner: 'StaticSourceFiles',
      source: rel(projectRoot, filePath),
      sourcePath: filePath,
      priority: 50,
      dedupePolicy: 'exact',
      content,
      charCount: content.length,
      tokenEstimate: Math.ceil(content.length / 4),
    });
  }
  const toolsDir = path.join(projectRoot, 'workflow', 'tools');
  if (fs.existsSync(toolsDir)) {
    for (const entry of fs.readdirSync(toolsDir).filter(f => f.endsWith('.js')).sort()) {
      const filePath = path.join(toolsDir, entry);
      const content = safeRead(filePath);
      collector.addBlock({
        id: `static-source.tools.${entry}`,
        type: 'static-source',
        owner: 'StaticSourceFiles',
        source: rel(projectRoot, filePath),
        sourcePath: filePath,
        priority: 40,
        dedupePolicy: 'exact',
        content,
        charCount: content.length,
        tokenEstimate: Math.ceil(content.length / 4),
      });
    }
  }
  const agentsDir = path.join(projectRoot, 'workflow', 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const entry of fs.readdirSync(agentsDir).filter(f => f.endsWith('.js')).sort()) {
      const filePath = path.join(agentsDir, entry);
      const content = safeRead(filePath);
      collector.addBlock({
        id: `static-source.agents.${entry}`,
        type: 'static-source',
        owner: 'StaticSourceFiles',
        source: rel(projectRoot, filePath),
        sourcePath: filePath,
        priority: 30,
        dedupePolicy: 'exact',
        content,
        charCount: content.length,
        tokenEstimate: Math.ceil(content.length / 4),
      });
    }
  }
}

function scanContextLoaderMandatoryDocs({ collector, projectRoot, filePath }) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const content = safeRead(filePath);
  collector.addBlock({
    id: 'context-loader.mandatory-docs',
    type: 'context-loader-config',
    owner: 'ContextLoader',
    source: rel(projectRoot, filePath),
    sourcePath: filePath,
    priority: 90,
    dedupePolicy: 'exact',
    content,
    charCount: content.length,
    tokenEstimate: Math.ceil(content.length / 4),
  });
}

function scanSkills({ collector, projectRoot }) {
  const skillsDir = path.join(projectRoot, 'workflow', 'skills');
  if (!fs.existsSync(skillsDir)) return;
  for (const entry of fs.readdirSync(skillsDir).filter(f => f.endsWith('.md')).sort()) {
    const filePath = path.join(skillsDir, entry);
    const content = safeRead(filePath);
    collector.addBlock({
      id: `skill.${entry.replace(/\.md$/, '')}`,
      type: 'skill',
      owner: 'SkillSystem',
      source: rel(projectRoot, filePath),
      sourcePath: filePath,
      priority: 70,
      dedupePolicy: 'normalized',
      content,
      charCount: content.length,
      tokenEstimate: Math.ceil(content.length / 4),
    });
  }
}

function scanContextDigests({ collector, projectRoot }) {
  const outputDir = path.join(projectRoot, 'output');
  for (const name of ['code-graph.json', 'project-profile.md', 'business-logic.json', 'api-endpoints.json', 'duplicate-patterns.json']) {
    const filePath = path.join(outputDir, name);
    if (!fs.existsSync(filePath)) continue;
    const content = safeRead(filePath);
    collector.addBlock({
      id: `context-digest.${name.replace(/\./g, '-')}`,
      type: 'context-digest',
      owner: 'ContextDigest',
      source: rel(projectRoot, filePath),
      sourcePath: filePath,
      priority: 60,
      dedupePolicy: 'exact',
      content,
      charCount: content.length,
      tokenEstimate: Math.ceil(content.length / 4),
    });
  }
}

module.exports = {
  scanStaticSourceFiles,
  scanContextLoaderMandatoryDocs,
  scanSkills,
  scanContextDigests,
};
