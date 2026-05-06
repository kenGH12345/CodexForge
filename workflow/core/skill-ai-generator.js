/**
 * Skill AI Generator — Produces high-quality SKILL.md from refined code-graph signals.
 *
 * Uses CapabilityMapper's refined signals (not raw symbol soup) to build
 * a dense, structured prompt. Supports both LLM-powered and direct-IDE-Agent modes.
 */

const path = require('path');
const { prepareGatewayPrompt } = require('./llm-injection-gateway');

const { CapabilityMapper } = require('./capability-mapper');
const { buildSkillYFM, buildSkillYFMTemplate } = require('./skill-yfm-builder');
const {
  assembleShardingPromptBlock,
  parseShardedOutput,
  validateSharding,
} = require('./skill-sharding');

const REQUIRED_SECTIONS = [
  'Module Scaffold',
  'Architecture Understanding',
  'Design Patterns',
  'Project Conventions',
  'Design Pattern Guidance',
  'Common Components & Utilities'
];

const DEFAULT_CONFIG = {
  maxRetries: 1,
  maxTokens: 4000,
  dryRun: false,
  force: false,
  outputDir: '.workflow/skills'
};

const CHARS_PER_TOKEN = 4;
const MAX_PROMPT_TOKENS = 6000;
const MAX_EMBED_TOKENS = 4000;

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function truncate(text, maxTokens) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 50) + '\n... (truncated for token budget) ...';
}

// ── Prompt Builder ─────────────────────────────────────

function buildPrompt(mapped, packaged) {
  const arch = mapped.architecture || {};
  const layers = arch.layers || {};
  const patterns = mapped.designPatterns || {};
  const standards = mapped.codingStandards || {};
  const relations = (arch.moduleRelations || []).slice(0, 15);
  const highValue = (mapped.highValueSymbols || []).slice(0, 20);
  const modules = (arch.modules || []).slice(0, 12);

  const lines = [];

  lines.push('# Skill Generation Task');
  lines.push('');
  lines.push('Analyze the following refined project signals and produce a comprehensive SKILL.md that captures:');
  lines.push('1. The project\'s architecture philosophy and key design decisions');
  lines.push('2. Domain-specific patterns, conventions, and best practices');
  lines.push('3. Critical files, entry points, and reusable components');
  lines.push('4. Anti-patterns to avoid and common pitfalls');
  lines.push('');

  // Layered Architecture
  lines.push('## Architecture Overview');
  const layerEntries = Object.entries(layers)
    .filter(([_, v]) => v.symbolCount > 0)
    .sort((a, b) => b[1].symbolCount - a[1].symbolCount);
  for (const [layer, info] of layerEntries) {
    lines.push(`### ${layer} Layer (${info.symbolCount} symbols, ${info.fileCount} files)`);
    for (const sym of info.keySymbols.slice(0, 5)) {
      lines.push(`- ${sym.name} (${sym.kind}) — ${sym.file}:${sym.line}`);
    }
  }
  lines.push('');

  // Modules with metrics
  if (modules.length > 0) {
    lines.push('## Key Modules');
    for (const mod of modules) {
      lines.push(`### ${mod.name}`);
      lines.push(`- Layer: ${mod.layer} | Symbols: ${mod.symbolCount} | Classes: ${mod.classCount} | Functions: ${mod.functionCount} | Files: ${mod.fileCount}`);
      if (mod.keySymbols && mod.keySymbols.length > 0) {
        lines.push(`- Key symbols:`);
        for (const sym of mod.keySymbols.slice(0, 5)) {
          lines.push(`  - ${sym.name} (${sym.kind})${sym.signature ? ` — ${sym.signature}` : ''}`);
        }
      }
    }
    lines.push('');
  }

  // Detected Design Patterns
  const detected = patterns.detected || [];
  if (detected.length > 0) {
    lines.push('## Detected Design Patterns');
    lines.push(`_Confidence: ${(patterns.confidence || 0).toFixed(2)}_`);
    lines.push('');
    for (const p of detected.slice(0, 12)) {
      lines.push(`### ${p.pattern} (${p.instanceCount} instances, confidence: ${(p.confidence || 0).toFixed(2)})`);
      for (const ev of p.evidence.slice(0, 4)) {
        lines.push(`- Evidence: ${ev}`);
      }
    }
    lines.push('');
  }

  // Module Relations (cross-module calls)
  if (relations.length > 0) {
    lines.push('## Module Dependencies (Top Cross-Module Call Pairs)');
    for (const r of relations.slice(0, 12)) {
      lines.push(`- ${r.from} → ${r.to} | ${r.callCount} calls`);
    }
    lines.push('');
  }

  // Coding Conventions
  const conventions = standards.conventions || [];
  if (conventions.length > 0) {
    lines.push('## Inferred Coding Conventions');
    for (const c of conventions) {
      lines.push(`- **${c.type}**: ${c.convention} (confidence: ${(c.confidence || 0).toFixed(2)})`);
      lines.push(`  - Evidence: ${c.evidence}`);
    }
    lines.push('');
  }

  // High-Value Symbols (project-specific, non-generic)
  if (highValue.length > 0) {
    lines.push('## Critical Project-Specific Symbols');
    for (const sym of highValue) {
      lines.push(`- **${sym.name}** (${sym.kind}) — ${sym.file}:${sym.line}${sym.signature ? ` — sig: ${sym.signature}` : ''}`);
    }
    lines.push('');
  }

  // Category stats
  const stats = mapped.categoryStats || {};
  if (Object.keys(stats).length > 0) {
    lines.push('## Symbol Category Distribution');
    for (const [cat, count] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${cat}: ${count}`);
    }
    lines.push('');
  }

  // Raw code context (very limited, only top modules)
  if (packaged && packaged.contextString) {
    lines.push('## Sample Source Code (Top Priority Modules Only)');
    lines.push('_Only showing representative files from highest-priority modules._');
    lines.push('');
    const raw = packaged.contextString;
    const topModuleSections = [];
    const modulesHeader = '# Module:';
    let idx = raw.indexOf(modulesHeader);
    let count = 0;
    while (idx !== -1 && count < 3) {
      const nextIdx = raw.indexOf(modulesHeader, idx + 1);
      const section = nextIdx === -1 ? raw.slice(idx) : raw.slice(idx, nextIdx);
      topModuleSections.push(section);
      idx = nextIdx;
      count++;
    }
    const sampleCode = topModuleSections.join('\n');
    lines.push(truncate(sampleCode, 800));
    lines.push('');
  }

  // Output instructions
  lines.push('---');
  lines.push('');
  lines.push('## Output Format');
  lines.push('');
  lines.push('You MUST produce a v2.1 sharded project-expert skill, not a single monolithic file.');
  lines.push('Use the exact file-delimiter protocol below; each delimiter must be on its own line.');
  lines.push('');
  lines.push('The `SKILL.md` block must start with YAML frontmatter (exact format; all fields required):');
  lines.push('');
  lines.push('```yaml');
  lines.push(buildSkillYFMTemplate().trimEnd());
  lines.push('```');
  lines.push('');
  lines.push(assembleShardingPromptBlock());
  lines.push('');
  lines.push('Content requirements:');
  lines.push('- BE SPECIFIC to this project. Generic advice is useless.');
  lines.push('- Cite concrete file names, function names, and module names from the signals above.');
  lines.push('- DO NOT put detailed single-quadrant sections into `SKILL.md`; put them into the assigned references file.');
  lines.push('- Every reusable component section must include copy-pasteable usage templates where possible.');
  lines.push('- If a quadrant is not applicable, still create its reference file and explain why it is N/A.');
  lines.push('');

  const prompt = lines.join('\n');
  const tokens = estimateTokens(prompt);
  if (tokens > MAX_PROMPT_TOKENS) {
    console.error(`[SkillAIGenerator] Prompt ${tokens} tokens exceeds ${MAX_PROMPT_TOKENS}; truncating`);
    return truncate(prompt, MAX_PROMPT_TOKENS);
  }
  console.error(`[SkillAIGenerator] Prompt built: ${tokens} tokens`);
  return prompt;
}

// ── Alternatives Inference ─────────────────────────────

function inferAlternatives(mapped) {
  const patterns = mapped.designPatterns || {};
  const detected = (patterns.detected || []).map(p => p.pattern);
  const suggestions = [];

  const patternsInProject = new Set(detected);

  if (patternsInProject.has('Factory') && !patternsInProject.has('Dependency Injection')) {
    suggestions.push({ pattern: 'Factory', suggestion: 'Consider adding a lightweight DI container if factory proliferation creates indirection overhead' });
  }
  if (patternsInProject.has('Singleton') && !patternsInProject.has('Registry')) {
    suggestions.push({ pattern: 'Singleton', suggestion: 'Replace singletons with a Registry pattern for testability and lifecycle control' });
  }
  if (patternsInProject.has('Observer') && !patternsInProject.has('Event Bus')) {
    suggestions.push({ pattern: 'Observer', suggestion: 'Consider centralizing with an Event Bus for cross-module decoupling' });
  }
  if (patternsInProject.has('Adapter') && !patternsInProject.has('Port/Adapter (Hexagonal)')) {
    suggestions.push({ pattern: 'Adapter', suggestion: 'If adapter count grows, structure as Ports & Adapters (Hexagonal Architecture)' });
  }
  if (patternsInProject.has('Pipeline') && !patternsInProject.has('Middleware Chain')) {
    suggestions.push({ pattern: 'Pipeline', suggestion: 'Formalize pipeline stages as a typed Middleware Chain with error propagation' });
  }
  if (patternsInProject.has('Strategy') && !patternsInProject.has('Plugin System')) {
    suggestions.push({ pattern: 'Strategy', suggestion: 'If strategies are numerous, upgrade to a Plugin System with discovery' });
  }
  if (detected.length === 0) {
    suggestions.push({ pattern: 'General', suggestion: 'No strong design patterns detected. Consider introducing Factory or Strategy to reduce complexity hotspots.' });
  }

  const layers = mapped.architecture && mapped.architecture.layers ? Object.keys(mapped.architecture.layers) : [];
  if (!layers.includes('test') || !layers.includes('integration')) {
    suggestions.push({ pattern: 'Testing', suggestion: 'Add dedicated integration-test layer; current test coverage may be unit-test heavy.' });
  }

  return suggestions;
}

// ── LLM Path ───────────────────────────────────────────

async function callLLM(prompt, { llmAdapterPath, timeoutMs = 90000, ideAgentCallback, cheapLlmCall } = {}) {
  // 1. If running in IDE Agent mode with a callback, use it directly
  if (typeof ideAgentCallback === 'function') {
    console.error('[SkillAIGenerator] Using IDE Agent direct callback');
    try {
      const result = await ideAgentCallback(prompt);
      return result;
    } catch (err) {
      console.error('[SkillAIGenerator] IDE Agent callback failed:', err.message);
      return null;
    }
  }

  // 2. If a cheap LLM call function is provided, use it (fast tier)
  if (typeof cheapLlmCall === 'function') {
    console.error('[SkillAIGenerator] Using cheapLlmCall for skill generation');
    try {
      const result = await cheapLlmCall(prepareGatewayPrompt({ _outputDir: null }, {
        callSite: 'workflow/core/skill-ai-generator.js:callLLM.cheap',
        role: 'skill-ai-generator',
        stage: 'EVOLVE',
        runtimePrompt: prompt,
        metadata: { category: 'llm-lite-call' },
      }));
      if (result && typeof result === 'string' && result.trim().length > 0) {
        return result;
      }
    } catch (err) {
      console.error('[SkillAIGenerator] cheapLlmCall failed:', err.message);
    }
  }

  // 3. Try loading an LLM adapter module (e.g., ide-llm-adapter.js)
  if (llmAdapterPath) {
    try {
      const adapter = require(llmAdapterPath);
      const callLLMFn = adapter.callLLM || adapter.generate || adapter.send;
      if (typeof callLLMFn === 'function') {
        console.error('[SkillAIGenerator] Using LLM adapter:', llmAdapterPath);
        return await callLLMFn({ prompt, temperature: 0.3, maxTokens: 4000, timeout: timeoutMs });
      }
    } catch (err) {
      console.error('[SkillAIGenerator] LLM adapter unavailable:', err.message);
    }
  }

  console.error('[SkillAIGenerator] No LLM path available (no adapter, no IDE callback, no cheapLlmCall)');
  return null;
}

// ── Fallback Builder ───────────────────────────────────

function _ensureMinKeywords(keywords, fallbackName) {
  const cleaned = (keywords || [])
    .filter(k => typeof k === 'string' && k.trim().length > 0)
    .map(k => k.replace(/'/g, ''));
  if (cleaned.length >= 3) return cleaned;
  const extras = [fallbackName, 'project', 'codebase'].filter(x => !cleaned.includes(x));
  return cleaned.concat(extras).slice(0, Math.max(3, cleaned.length + extras.length));
}

function _buildFallbackDescription(scaffold, mapped) {
  const name = scaffold.projectName || scaffold.projectType || 'Project';
  const arch = scaffold.architecture || 'unknown architecture';
  const moduleCount = (mapped && mapped.architecture && mapped.architecture.modules || []).length;
  const domainHint = scaffold.projectType && scaffold.projectType !== name ? ` / ${scaffold.projectType}` : '';
  const desc = `Project-expert skill for ${name}${domainHint} (${arch}). Covers ${moduleCount} modules, key reusable utilities, design patterns, and common pitfalls detected from static analysis. Auto-generated from code-graph signals.`;
  return desc;
}

function _deriveDomainsFromMapped(mapped, scaffold) {
  const out = new Set();
  if (scaffold && scaffold.projectType) out.add(String(scaffold.projectType).toLowerCase().replace(/\s+/g, '-'));
  if (scaffold && scaffold.architecture) out.add(String(scaffold.architecture).toLowerCase().replace(/\s+/g, '-'));
  const patterns = mapped && mapped.designPatterns && mapped.designPatterns.detected;
  if (Array.isArray(patterns)) for (const p of patterns.slice(0, 3)) if (p && p.pattern) out.add(String(p.pattern).toLowerCase());
  return Array.from(out).slice(0, 5);
}

function _minimalFallbackYFM(name, keywords, roles) {
  // Disaster recovery: if buildSkillYFM itself throws, fall back to a hand-rolled
  // minimum-viable YFM that still has triggers.keywords so ContextLoader can match.
  const safeKw = keywords.map(k => String(k).replace(/'/g, '')).join(', ');
  const safeRoles = roles.join(', ');
  return [
    '---',
    `name: ${name}`,
    'version: 1.0.0',
    'type: project-expert-skill',
    `description: Auto-generated project-expert skill for ${name} (minimal fallback YFM).`,
    'triggers:',
    `  keywords: [${safeKw}]`,
    `  roles: [${safeRoles}]`,
    'load_level: session',
    `generatedAt: ${new Date().toISOString()}`,
    '---',
    '',
  ].join('\n');
}

function buildFallbackSkill(mapped) {
  const scaffold = mapped.scaffold || {};
  const patterns = mapped.designPatterns || {};
  const standards = mapped.codingStandards || {};
  const detected = (patterns.detected || []).map(p => p.pattern);
  const conventions = standards.conventions || [];
  const highValue = mapped.highValueSymbols || [];
  const layers = mapped.architecture && mapped.architecture.layers ? mapped.architecture.layers : {};
  const relations = (mapped.architecture && mapped.architecture.moduleRelations) || [];

  const triggers = mapped.triggers || { keywords: [], roles: ['developer'] };
  const lines = [];

  const projectName = scaffold.projectName || scaffold.projectType || 'Project';
  const keywords = _ensureMinKeywords(triggers.keywords || [], projectName);
  const roles = (triggers.roles && triggers.roles.length > 0) ? triggers.roles : ['developer'];
  const description = _buildFallbackDescription(scaffold, mapped);
  const domains = _deriveDomainsFromMapped(mapped, scaffold);

  // YFM via single source of truth — skill-yfm-builder.js
  let yfmString;
  try {
    yfmString = buildSkillYFM({
      name: projectName,
      version: '1.0.0',
      type: 'project-expert-skill',
      description,
      domains,
      triggers: { keywords, roles },
      load_level: 'session',
      max_tokens: 2000,
      generatedAt: new Date().toISOString(),
      llmPowered: false,
    });
  } catch (err) {
    console.error(`[SkillAIGenerator] YFM builder failed: ${err.message}; using minimal fallback`);
    yfmString = _minimalFallbackYFM(projectName, keywords, roles);
  }
  lines.push(yfmString.trimEnd());
  lines.push('');

  lines.push(`# ${projectName} Skill Guide (Auto-Generated)`);
  lines.push('');
  lines.push('> ℹ️ Generated by WorkFlowAgent Skill Generator (fallback mode — signals-based, no LLM reasoning)');
  lines.push('');

  // Section 1 — Architecture
  lines.push('## 1. Project Architecture & Philosophy');
  lines.push('');
  lines.push(`**Project Type**: ${scaffold.projectType || 'unknown'}`);
  lines.push(`**Architecture Style**: ${scaffold.architecture || 'unknown'}`);
  lines.push('');
  const layerNames = Object.keys(layers);
  if (layerNames.length > 0) {
    lines.push(`**Detected Layers**: ${layerNames.join(', ')}`);
    for (const [name, info] of Object.entries(layers)) {
      lines.push(`- ${name}: ${info.symbolCount} symbols across ${info.fileCount} files`);
    }
  }
  lines.push('');
  if (relations.length > 0) {
    lines.push('**Top Cross-Module Dependencies**:')  ;
    for (const r of relations.slice(0, 8)) {
      lines.push(`- ${r.from} → ${r.to} (${r.callCount} calls)`);
    }
    lines.push('');
  }
  lines.push('**Philosophy** (signal-inferred):');
  if (detected.includes('Pipeline')) {
    lines.push('- The codebase is structured around sequential stage processing (Pipeline pattern).');
  }
  if (detected.includes('Command')) {
    lines.push('- Operations are encapsulated as discrete commands with clear entry points.');
  }
  if (detected.includes('Observer') || detected.includes('Event Bus')) {
    lines.push('- Event-driven communication is used for loose coupling between modules.');
  }
  if (layerNames.includes('utility') && layerNames.includes('core')) {
    lines.push('- Clear separation between utility/tooling layer and core business logic.');
  }
  if (detected.length === 0) {
    lines.push('- No dominant design patterns detected. Architecture appears flat and procedural.');
  }
  lines.push('');

  // Section 2 — Key Files
  lines.push('## 2. Key Files & Entry Points');
  lines.push('');
  const entryPoints = scaffold.entryPoints || [];
  const uniqueEntries = [...new Set(entryPoints)].slice(0, 10);
  if (uniqueEntries.length > 0) {
    for (const ep of uniqueEntries) {
      lines.push(`- \`${ep}\``);
    }
  } else {
    lines.push('- No explicit entry points detected from signal analysis.');
  }
  lines.push('');
  const coreServices = (scaffold.coreServices || []).slice(0, 10);
  if (coreServices.length > 0) {
    lines.push('**Core Services / Key Functions**: ' + coreServices.join(', '));
    lines.push('');
  }

  // Section 3 — Patterns & Conventions
  lines.push('## 3. Design Patterns & Conventions');
  lines.push('');
  if (detected.length > 0) {
    lines.push('**Detected Patterns**: ' + detected.join(', '));
    const detectedDetails = (patterns.detected || []);
    for (const p of detectedDetails.slice(0, 8)) {
      lines.push(`\n### ${p.pattern} (${p.instanceCount} instances)`);
      for (const ev of p.evidence.slice(0, 3)) {
        lines.push(`- ${ev}`);
      }
    }
  } else {
    lines.push('No design patterns detected from symbol analysis.');
  }
  lines.push('');
  if (conventions.length > 0) {
    lines.push('**Coding Conventions**:');
    for (const c of conventions) {
      lines.push(`- ${c.type}: ${c.convention} (${c.evidence})`);
    }
    lines.push('');
  }

  // Section 4 — Reusable Components with Code Templates
  lines.push('## 4. Reusable Components & APIs');
  lines.push('');
  if (highValue.length > 0) {
    for (const sym of highValue.slice(0, 15)) {
      lines.push(`### ${sym.name}`);
      lines.push(`- **Kind**: ${sym.kind} | **Location**: \`${sym.file}:${sym.line}\``);
      if (sym.signature) {
        lines.push(`- **Signature**: \`${sym.signature}\``);
      }
      lines.push('');
      // Generate a code template from signature if available
      const template = _generateSymbolTemplate(sym, scaffold);
      if (template) {
        lines.push('**Copy-Paste Template**:');
        lines.push('```');
        lines.push(template);
        lines.push('```');
        lines.push('');
      }
    }
  } else {
    lines.push('- No reusable components detected.');
  }
  lines.push('');

  // Section 5 — Pitfalls
  lines.push('## 5. Common Pitfalls & Anti-patterns');
  lines.push('');
  const alternatives = inferAlternatives(mapped);
  if (alternatives.length > 0) {
    lines.push('**Suggested Improvements**:');
    for (const a of alternatives) {
      lines.push(`- **${a.pattern}**: ${a.suggestion}`);
    }
  } else {
    lines.push('- No specific anti-patterns detected. Maintain current conventions.');
  }
  lines.push('');
  if (relations.length > 0) {
    const top = relations[0];
    lines.push(`**Coupling Risk**: Highest cross-module coupling is ${top.from} → ${top.to} (${top.callCount} calls). Changes in ${top.from} may cascade unexpectedly.`);
    lines.push('');
  }

  // Section 6 — Testing
  lines.push('## 6. Testing & Quality Standards');
  lines.push('');
  if (layerNames.includes('test')) {
    lines.push('- Test files are present. Review test organization for consistency with production code structure.');
  } else {
    lines.push('- No dedicated test layer detected. Consider adding structured test directories.');
  }
  if (conventions.some(c => c.type === 'test-location')) {
    const tc = conventions.find(c => c.type === 'test-location');
    lines.push(`- ${tc.convention} (${tc.evidence})`);
  }
  lines.push('');

  return lines.join('\n');
}

function buildFallbackReferenceFiles(mapped) {
  const scaffold = mapped.scaffold || {};
  const arch = mapped.architecture || {};
  const patterns = mapped.designPatterns || {};
  const standards = mapped.codingStandards || {};
  const highValue = mapped.highValueSymbols || [];
  const relations = arch.moduleRelations || [];
  const layers = arch.layers || {};
  const modules = arch.modules || [];
  const moduleNames = modules.map(m => m.name || '').join('\n');
  const hasUnityGameSignals = /UICtrl|Systems|Core|LiteCore|TDR|XLuaWork/i.test(moduleNames);
  const hasUI = /UICtrl/i.test(moduleNames);
  const hasSystems = /Systems/i.test(moduleNames);
  const hasProtocol = /TDR/i.test(moduleNames);
  const hasLua = /XLuaWork|XLua/i.test(moduleNames);

  const d1 = [
    '# D1 Structure — 模块、层次与可复用组件',
    '',
    '## §3 模块管理',
    modules.length > 0
      ? modules.slice(0, 20).map(m => `- ${m.name}: ${m.symbolCount || 0} symbols, ${m.fileCount || 0} files`).join('\n')
      : '- No module signal detected.',
    '',
    '## §5 架构框架（MVC/分层）',
    Object.keys(layers).length > 0
      ? Object.entries(layers).map(([name, info]) => `- ${name}: ${(info && info.symbolCount) || 0} symbols / ${(info && info.fileCount) || 0} files`).join('\n')
      : '- No explicit architecture layer signal detected.',
    '',
    '## §12 公共组件与工具库',
    highValue.length > 0
      ? highValue.slice(0, 15).map(sym => `- ${sym.name} (${sym.kind}) — ${sym.file}:${sym.line}${sym.signature ? ` — ${sym.signature}` : ''}`).join('\n')
      : '- No reusable symbols detected.',
  ].join('\n');

  const detected = patterns.detected || [];
  const d2 = [
    '# D2 Behavior — 流程、模式、状态与日志',
    '',
    '## §2 项目流程与生命周期',
    (scaffold.entryPoints || []).length > 0
      ? (scaffold.entryPoints || []).slice(0, 10).map(ep => `- Entry: ${ep}`).join('\n')
      : '- No explicit entry points detected.',
    '',
    '## §4 设计模式',
    detected.length > 0
      ? detected.slice(0, 10).map(p => `- ${p.pattern}: ${p.instanceCount || 0} instances, confidence ${(p.confidence || 0).toFixed(2)}`).join('\n')
      : '- No dominant pattern detected.',
    '',
    '## §7 状态管理',
    hasUnityGameSignals
      ? [
        '- Unity/WePop-like state signals detected from modules: `Core`, `LiteCore`, `Systems`, `UICtrl`.',
        hasUI ? '- `UICtrl` usually owns UI screen state, restoration and controller/view transitions.' : null,
        hasSystems ? '- `Systems` modules usually own domain feature state and coordinate with core runtime.' : null,
        /LiteCore/i.test(moduleNames) ? '- `LiteCore` should be treated as a lightweight parallel runtime path; changes often need Core/LiteCore sync review.' : null,
      ].filter(Boolean).join('\n')
      : '- No dedicated state-management signal detected from static analysis.',
    '',
    '## §11 日志系统',
    highValue.some(s => /Log(Error|Info|Warning)|Debug/i.test(s.name))
      ? highValue.filter(s => /Log(Error|Info|Warning)|Debug/i.test(s.name)).slice(0, 6).map(s => `- ${s.name}: ${s.file}:${s.line}`).join('\n')
      : '- Logger conventions should be verified manually from project files.',
  ].join('\n');

  const d3 = [
    '# D3 Communication — 事件、网络、数据流与影响半径',
    '',
    '## §6 事件系统',
    detected.some(p => /Observer|Event/i.test(p.pattern)) || hasUnityGameSignals
      ? '- Event/observer-like communication signals detected; verify event payload contracts before cross-module changes.'
      : '- No strong event-system signal detected.',
    '',
    '## §10 网络通信',
    hasProtocol ? '- `TDR` protocol modules detected; network/data contracts should be treated as schema-bound and regeneration-sensitive.' : '- Network/protocol usage requires project-specific follow-up if relevant.',
    '',
    '## §13 MVC 数据流与绑定',
    hasUI ? '- `UICtrl` modules detected; assume controller/view/model UI flow and validate binding names, prefab/resource links and restoration paths.' : '- Data-flow binding signals require code-level verification.',
    '',
    '## §14 模块间通讯契约',
    relations.length > 0 ? relations.slice(0, 12).map(r => `- ${r.from} → ${r.to}: ${r.callCount} calls`).join('\n') : '- No cross-module relation signal detected.',
    '',
    '## §M-2 修改影响半径',
    relations.length > 0 ? `- Highest observed coupling: ${relations[0].from} → ${relations[0].to}` : '- No impact-radius data detected.',
  ].join('\n');

  const conventions = standards.conventions || [];
  const d4 = [
    '# D4 Contract — 配置、持久化、协议与容错',
    '',
    '## §8 配置与数据驱动',
    conventions.length > 0 ? conventions.slice(0, 8).map(c => `- ${c.type}: ${c.convention}`).join('\n') : '- No configuration convention detected.',
    '',
    '## §9 持久化与存档',
    hasUnityGameSignals ? '- Unity client persistence may span local cache, PlayerPrefs/JSON-style state and server-authoritative feature data; verify module owner before changing state writes.' : '- Persistence behavior requires project-specific verification.',
    '',
    '## §15 协议与契约定义',
    hasProtocol ? '- `TDR` protocol modules detected; field/schema changes require contract review and generated-code compatibility checks.' : '- Protocol contracts require project-specific verification.',
    '',
    '## §M-1 错误处理与容错',
    hasLua ? '- `XLuaWork`/XLua signals detected; hotfix/config bridge failures need guarded fallback and clear C#↔Lua boundary checks.' : '- Error-handling strategy should be verified from source before critical changes.',
  ].join('\n');

  return {
    'references/d1-structure.md': d1,
    'references/d2-behavior.md': d2,
    'references/d3-communication.md': d3,
    'references/d4-contract.md': d4,
  };
}

// ── Helper: Code Template Generator ──────────────────

function _generateSymbolTemplate(sym, scaffold) {
  if (!sym.signature || sym.signature === '()') return null;

  const ext = (sym.file || '').split('.').pop() || 'js';
  const isTS = ext === 'ts' || ext === 'tsx';
  const isJS = ext === 'js' || ext === 'jsx' || ext === 'mjs' || !isTS;
  const isPy = ext === 'py';
  const isCSharp = ext === 'cs';

  if (sym.kind === 'function' || sym.kind === 'method') {
    const params = sym.params && sym.params.length > 0
      ? sym.params.map(p => `  // @param {any} ${p}`).join('\n')
      : '  // @param — (no parameters)';

    if (isPy) {
      return `${sym.signature}:\n    # TODO: implement
    raise NotImplementedError()`;
    } else if (isCSharp) {
      return `// ${sym.signature}\n{
    // TODO: implement
    throw new NotImplementedException();
}`;
    } else {
      return `// ${sym.signature}\n${params}
function ${sym.name}${sym.signature} {
    // TODO: implement based on domain logic
}`;
    }
  }

  if (sym.kind === 'class') {
    if (isPy) {
      return `class ${sym.name}:
    def __init__(self):
        # TODO: initialize
        pass`;
    } else if (isCSharp) {
      return `public class ${sym.name}
{
    public ${sym.name}()
    {
        // TODO: constructor
    }
}`;
    } else {
      return `class ${sym.name} {
${params}
    constructor${sym.signature || '()'} {
        // TODO: initialize
    }
}`;
    }
  }

  return null;
}

// ── Main Entry Points ──────────────────────────────────

async function generateSkillFromPackaged(packaged, codeGraph, options = {}) {
  console.error('[SkillAIGenerator] Starting skill generation');

  if (!packaged || !codeGraph) {
    throw new Error('SkillPackager output and CodeGraph required');
  }

  const mapper = new CapabilityMapper();
  const mapped = mapper.mapCapabilities(codeGraph);

  console.error('[SkillAIGenerator] Mapped capabilities:');
  console.error(`  - Modules: ${(mapped.architecture && mapped.architecture.modules || []).length}`);
  console.error(`  - Patterns: ${(mapped.designPatterns && mapped.designPatterns.detected || []).length}`);
  console.error(`  - Conventions: ${(mapped.codingStandards && mapped.codingStandards.conventions || []).length}`);
  console.error(`  - High-value symbols: ${(mapped.highValueSymbols || []).length}`);

  const prompt = buildPrompt(mapped, packaged);

  let skillMarkdown = null;
  let referenceFiles = {};
  let shardingMode = 'single';
  let shardingWarnings = [];

  // Attempt LLM path
  const llmResult = await callLLM(prompt, {
    llmAdapterPath: options.llmAdapterPath || options.llmModule,
    timeoutMs: options.timeoutMs || 90000,
    ideAgentCallback: options.ideAgentCallback,
    cheapLlmCall: options.cheapLlmCall,
  });

  const llmPowered = !!llmResult && typeof llmResult === 'string' && llmResult.trim().length > 500;
  if (llmPowered) {
    const parsed = parseShardedOutput(llmResult.trim());
    shardingWarnings = shardingWarnings.concat(parsed.warnings || []);
    if (parsed.parseMode === 'sharded' && parsed.files.has('SKILL.md')) {
      skillMarkdown = parsed.files.get('SKILL.md');
      referenceFiles = Object.fromEntries([...parsed.files.entries()].filter(([name]) => name !== 'SKILL.md'));
      shardingMode = 'sharded';
      const validation = validateSharding(parsed.files);
      shardingWarnings = shardingWarnings.concat(validation.warnings || [], validation.errors || []);
      console.error(`[SkillAIGenerator] LLM sharded skill generation succeeded (${Object.keys(referenceFiles).length} reference files)`);
    } else if (parsed.parseMode === 'single' && parsed.files.has('SKILL.md')) {
      skillMarkdown = parsed.files.get('SKILL.md');
      console.error('[SkillAIGenerator] LLM returned single-file skill; using compatibility mode');
    } else {
      console.error('[SkillAIGenerator] LLM output malformed; building fallback sharded skill');
    }
  }

  if (!skillMarkdown) {
    console.error('[SkillAIGenerator] LLM unavailable/insufficient/malformed; building fallback sharded skill from refined signals');
    skillMarkdown = buildFallbackSkill(mapped);
    referenceFiles = buildFallbackReferenceFiles(mapped);
    shardingMode = 'fallback-sharded';
    const validation = validateSharding(new Map([['SKILL.md', skillMarkdown], ...Object.entries(referenceFiles)]));
    shardingWarnings = shardingWarnings.concat(validation.warnings || [], validation.errors || []);
  }

  // YFM safety net: if SKILL.md lacks frontmatter, inject one via single source of truth
  if (!skillMarkdown.startsWith('---')) {
    const triggers = mapped.triggers || { keywords: [], roles: ['developer'] };
    const fallbackName = options.projectName || (packaged.modules && packaged.modules[0] && packaged.modules[0].name) || 'Unknown Project';
    const keywords = _ensureMinKeywords(triggers.keywords || [], fallbackName);
    const roles = (triggers.roles && triggers.roles.length > 0) ? triggers.roles : ['developer'];
    const description = _buildFallbackDescription(mapped.scaffold || {}, mapped);
    const domains = _deriveDomainsFromMapped(mapped, mapped.scaffold || {});

    let frontmatter;
    try {
      frontmatter = buildSkillYFM({
        name: fallbackName,
        version: '1.0.0',
        type: 'project-expert-skill',
        description,
        domains,
        triggers: { keywords, roles },
        load_level: 'session',
        max_tokens: 2000,
        generatedAt: new Date().toISOString(),
        llmPowered,
      });
    } catch (err) {
      console.error(`[SkillAIGenerator] YFM builder failed in safety net: ${err.message}; using minimal fallback`);
      frontmatter = _minimalFallbackYFM(fallbackName, keywords, roles);
    }
    skillMarkdown = frontmatter + skillMarkdown;
    console.error('[SkillAIGenerator] Injected missing YFM frontmatter');
  }

  const metadata = {
    projectName: options.projectName || (packaged.modules && packaged.modules[0] && packaged.modules[0].name) || 'Unknown Project',
    moduleCount: (mapped.architecture && mapped.architecture.modules || []).length,
    patternCount: (mapped.designPatterns && mapped.designPatterns.detected || []).length,
    detectedPatterns: (mapped.designPatterns && mapped.designPatterns.detected || []).map(p => p.pattern),
    alternatives: inferAlternatives(mapped),
    llmPowered,
    shardingMode,
    referenceFileCount: Object.keys(referenceFiles || {}).length,
    shardingWarnings,
    tokenEstimate: estimateTokens(skillMarkdown),
    generatedAt: new Date().toISOString()
  };

  return { skillMarkdown, referenceFiles, shardingMode, shardingWarnings, mapping: mapped, metadata };
}

/**
 * Legacy adapter — supports two calling conventions:
 *   A. generateSkill(requirement, context, options) — old 3-arg style
 *   B. generateSkill(projectRoot, options) — bridge/facade 2-arg style
 *
 * In mode B, loads layered CodeGraph (L1 index + L2 shards, legacy fallback only for old projects)
 * from projectRoot and builds packaged context from fileList.
 */
async function generateSkill(arg1, arg2, arg3) {
  let packaged, codeGraph, options;

  if (arg3 && typeof arg3 === 'object') {
    // Mode A: generateSkill(requirement, context, options)
    packaged = arg2 || {};
    codeGraph = arg1 || {};
    options = arg3 || {};
  } else if (typeof arg1 === 'string' && arg2 && typeof arg2 === 'object') {
    // Mode B: generateSkill(projectRoot, options) — bridge/facade style
    const projectRoot = arg1;
    options = arg2 || {};
    const path = require('path');

    try {
      const { loadLayeredCodeGraph } = require('./code-graph-layered-reader');
      codeGraph = loadLayeredCodeGraph(projectRoot, {
        includeTopShards: true,
        // Dual budget: stop once either cap is reached. Raised defaults so
        // projects with many small shards (after Pass-2 split) still get
        // adequate coverage. Explicit options override.
        maxShards: options.maxShards || 8,
        maxSymbols: options.maxSymbols || 25000,
      });
    } catch (err) {
      console.error(`[SkillAIGenerator] Could not load layered code graph: ${err.message}`);
      codeGraph = { source: 'missing', modules: [], hotspots: [], reusableSymbols: [] };
    }

    // Build lightweight packaged context from fileList or projectRoot
    const fileList = options.fileList || [];
    const modules = [];
    const seen = new Set();
    for (const fp of fileList) {
      const dir = path.dirname(fp).split(/[\\/]/).pop() || 'root';
      if (!seen.has(dir)) {
        seen.add(dir);
        modules.push({ name: dir, files: [fp] });
      } else {
        const m = modules.find(x => x.name === dir);
        if (m) m.files.push(fp);
      }
    }
    packaged = { modules, contextString: '', projectType: 'unknown' };
  } else {
    console.error('[SkillAIGenerator] Unrecognized call signature — using fallback');
    packaged = {};
    codeGraph = arg1 || {};
    options = arg2 || {};
  }

  return generateSkillFromPackaged(packaged, codeGraph, options);
}

module.exports = {
  generateSkill,
  generateSkillFromPackaged,
  buildPrompt,
  inferAlternatives,
  buildFallbackSkill,
  buildFallbackReferenceFiles
};
