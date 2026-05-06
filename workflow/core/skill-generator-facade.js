'use strict';

const fs = require('fs');
const path = require('path');
const { discoverProjectSkills } = require('./skill-discovery');
const { generateSkillFromPackaged } = require('./skill-ai-generator');
const { atomicWriteShardedSkill } = require('./skill-sharding');

/**
 * MockDetector — detects low-quality or placeholder skill content.
 */
class MockDetector {
  static isMockContent(content) {
    if (!content || typeof content !== 'string') return true;

    const patterns = [
      /\[Mock/i,
      /placeholder/i,
      /stub/i,
      /TODO[:\s]+generate/i,
      /configure\s+llmCall/i,
      /LLM_SKIPPED/i,
      /_No\s+conventions\s+detected\._/,
      /defined\s+yet/i,
    ];
    if (patterns.some(p => p.test(content))) return true;

    const meaningful = content.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('---')
        && !l.startsWith('|') && !l.startsWith('<!--'))
      .filter(l => l.length > 3);
    return meaningful.length < 10;
  }
}

/**
 * NoiseFilter — removes noisy directories from file lists.
 */
class NoiseFilter {
  static filterFileList(fileList) {
    if (!Array.isArray(fileList)) return [];
    const noise = [/\/output\//, /\.codebuddy\//, /\/generated\//, /\/docs\//,
      /\/tests?\//, /\/__tests__\//, /\/node_modules\//, /\/dist\//, /\/build\//];
    return fileList.filter(f => !noise.some(p => p.test(f)));
  }
}

/**
 * Unified skill generator facade.
 * Orchestrates project-standards (rule-based) + project-specific skill (AI).
 *
 * @param {string} projectRoot
 * @param {object} [options]
 * @param {number} [options.maxFiles=1000]
 * @param {string[]} [options.fileList]
 * @param {boolean} [options.force=false]
 * @param {object} [options.skillEvolution]
 * @param {Function} [options.llmCall]
 * @param {Function} [options.cheapLlmCall]
 * @param {boolean} [options.dryRun]
 * @returns {Promise<object>}
 */
async function generate(projectRoot, options = {}) {
  const result = {
    skillName: null,
    skillPath: null,
    signalCount: 0,
    confidenceSummary: null,
    standards: null,
    projectSkill: null,
    error: null,
  };

  const filteredFiles = NoiseFilter.filterFileList(options.fileList);

  // Phase 1: project-standards via rule-based discovery
  try {
    const standards = await discoverProjectSkills({
      projectRoot,
      skillEvolution: options.skillEvolution,
      llmCall: options.llmCall,
      cheapLlmCall: options.cheapLlmCall,
      force: options.force,
      skillName: 'project-standards',
    });
    result.standards = standards;
    if (standards.discovered) {
      result.signalCount += standards.signalCount || 0;
    }
  } catch (err) {
    console.warn(`[SkillGeneratorFacade] Standards generation failed: ${err.message}`);
  }

  const projectName = path.basename(projectRoot);
  const skillNameBase = `${projectName}`;

  // Phase 2: project-specific skill via AI generator (generateSkillFromPackaged)
  try {
    let codeGraph = {};
    try {
      const { loadSemanticCodeGraph } = require('./semantic-code-graph-adapter');
      codeGraph = loadSemanticCodeGraph(projectRoot, { includeAllShards: true }).toCapabilityCodeGraph();
    } catch (cgErr) {
      console.warn(`[SkillGeneratorFacade] Could not load semantic layered code graph: ${cgErr.message}`);
      codeGraph = { source: 'missing', modules: [], hotspots: [], reusableSymbols: [] };
    }

    // Build packaged context from filtered file list
    const modules = [];
    const seen = new Set();
    for (const fp of filteredFiles) {
      const dir = path.dirname(fp).split(/[\\/]/).pop() || 'root';
      if (!seen.has(dir)) {
        seen.add(dir);
        modules.push({ name: dir, files: [fp] });
      } else {
        const m = modules.find(x => x.name === dir);
        if (m) m.files.push(fp);
      }
    }
    const packaged = { modules, contextString: '', projectType: 'unknown' };

    const aiResult = await generateSkillFromPackaged(packaged, codeGraph, {
      llmAdapterPath: options.llmAdapterPath,
      ideAgentCallback: options.ideAgentCallback,
      cheapLlmCall: options.cheapLlmCall,
      llmCall: options.llmCall,
      maxFiles: options.maxFiles || 1000,
      force: options.force,
      dryRun: options.dryRun,
      skillName: skillNameBase,
      outputDir: '.workflow/skills',
    });
    result.projectSkill = aiResult;
    if (aiResult && aiResult.skillMarkdown) {
      result.skillName = skillNameBase;
      const skillDir = path.join(projectRoot, '.workflow', 'skills', skillNameBase.toLowerCase());
      result.skillPath = path.join(skillDir, 'SKILL.md');
      result.referencePaths = [];
      result.shardingMode = aiResult.shardingMode || 'single';
      const baseConfidence = (aiResult.metadata && aiResult.metadata.llmPowered) ? 0.7 : 0.5;
      const sectionCount = (aiResult.skillMarkdown || '').split('##').length - 1;
      const referenceCount = Object.keys(aiResult.referenceFiles || {}).length;
      const sectionBoost = Math.min(0.25, (sectionCount + referenceCount) * 0.04);
      result.confidenceSummary = { overall: Math.min(0.95, baseConfidence + sectionBoost) };
      result.wasFallback = !((aiResult.metadata && aiResult.metadata.llmPowered));

      if (!options.dryRun) {
        const writeResult = atomicWriteShardedSkill(skillDir, aiResult.skillMarkdown, aiResult.referenceFiles || {});
        result.writeResult = writeResult;
        result.referencePaths = Object.keys(aiResult.referenceFiles || {})
          .map(rel => path.join(skillDir, rel));
      }
    } else {
      result.error = 'Skill generation returned no content';
    }
  } catch (err) {
    result.error = err.message;
    console.warn(`[SkillGeneratorFacade] Project skill generation failed: ${err.message}`);
  }

  return result;
}

module.exports = {
  generate,
  MockDetector,
  NoiseFilter,
  _detectMock: (c) => MockDetector.isMockContent(c),
  _filterNoise: (l) => NoiseFilter.filterFileList(l),
};
