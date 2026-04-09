/**
 * Prompt Builder – LLM Prompt Engineering & Context Optimisation
 *
 * Implements Requirement 8: LLM bottom-layer principle optimisation.
 *
 * Key principles applied:
 *  1. KV Cache friendly: fixed prefix + dynamic suffix separation
 *  2. Full context loading: load all relevant context, avoid truncation
 *  3. Noise detection: warn when token count exceeds hallucination risk threshold
 *  4. Signal-to-noise maximisation: structured, clean prompts
 */

'use strict';

const fs = require('fs');
const nodePath = require('path');
const { LLM, PATHS, WORKFLOW_ROOT } = require('../core/constants');
const { getConfig } = require('../core/config-loader');
const { estimateTokens } = require('../tools/thin-tools');
const { ContextLoader } = require('./context-loader');
const { PromptSlotManager } = require('./prompt-slot-manager');
const { generateIDEToolGuidance, getIDEDetectionResult } = require('./ide-detection');
const { introspectionCollector } = require('./workflow-introspection-collector');
const { SELF_REPORT_INSTRUCTION } = require('./agent-self-report');

// ─── Pattern Library (P2: Cross-platform prompt patterns) ────────────────────

const { PromptPatternLibrary, createWorkflowPatternLibrary, detectPlatform } = require('./prompt-pattern-library');

// ─── Agent Fixed Prefixes (extracted to prompt-agent-prefixes.js) ───────────

const { AGENT_FIXED_PREFIXES } = require('./prompt-agent-prefixes');

// ─── KV Cache Friendly Prompt Structure ──────────────────────────────────────

/**
 * Builds a KV-Cache-optimised prompt by separating:
 *  - FIXED PREFIX: system role, constraints, output format (cached across calls)
 *  - DYNAMIC SUFFIX: the actual input content (changes each call)
 *
 * This structure maximises KV Cache hit rate, reducing compute cost.
 *
 * @param {string} fixedPrefix  - Static system instructions (role, constraints, format)
 * @param {string} dynamicSuffix - Dynamic input content (changes per call)
 * @returns {{ prompt: string, meta: PromptMeta }}
 */
function buildKVCacheFriendlyPrompt(fixedPrefix, dynamicSuffix) {
  // Separator clearly marks the boundary for KV cache optimisation
  const KV_CACHE_BOUNDARY = '\n\n<!-- KV_CACHE_BOUNDARY: dynamic content below -->\n\n';
  const prompt = fixedPrefix + KV_CACHE_BOUNDARY + dynamicSuffix;

  // Optimization C: Expose cache breakpoint metadata so the LLM adapter layer
  // can leverage API-level Prompt Caching (Anthropic cache_control, OpenAI
  // automatic prefix caching). The fixedPrefix is stable across calls for the
  // same role, making it an ideal caching candidate.
  //
  // Usage in LLM adapter:
  //   if (meta.cacheBreakpoint) {
  //     // Send as messages array with cache_control on system message
  //     messages = [
  //       { role: 'system', content: meta.cacheablePrefix, cache_control: { type: 'ephemeral' } },
  //       { role: 'user', content: meta.dynamicSuffix }
  //     ];
  //   }
  return _annotatePrompt(prompt, {
    kvCacheOptimised: true,
    fixedPrefixLength: fixedPrefix.length,
    // Optimization C: API Prompt Caching support
    cacheBreakpoint: fixedPrefix.length,
    cacheablePrefix: fixedPrefix,
    dynamicSuffix: dynamicSuffix,
  });
}

// ─── Full Context Loader ──────────────────────────────────────────────────────

/**
 * Loads all relevant context files and assembles them into a single prompt.
 * Implements "load full context, avoid truncation" principle.
 *
 * @param {string}   basePrompt      - The core task prompt
 * @param {string[]} contextFilePaths - Paths to context files to include
 * @param {object}   [options]
 * @param {boolean}  [options.includeAgentsMd=true] - Whether to prepend AGENTS.md
 * @returns {{ prompt: string, meta: PromptMeta }}
 */
function buildFullContextPrompt(basePrompt, contextFilePaths = [], options = {}) {
  const { includeAgentsMd = true } = options;
  const sections = [];

  // 1. Global context (AGENTS.md) – always first for KV cache efficiency
  if (includeAgentsMd) {
    const agentsMdPath = PATHS.AGENTS_MD;
    if (fs.existsSync(agentsMdPath)) {
      const agentsMd = fs.readFileSync(agentsMdPath, 'utf-8');
      sections.push(`## Global Project Context (AGENTS.md)\n\n${agentsMd}`);
    }
  }

  // 2. Additional context files
  for (const filePath of contextFilePaths) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const fileName = nodePath.basename(filePath);
      sections.push(`## Context: ${fileName}\n\n${content}`);
    } else {
      console.warn(`[PromptBuilder] Context file not found, skipping: "${filePath}"`);
    }
  }

  // 3. Base prompt (dynamic – goes last)
  sections.push(`## Task\n\n${basePrompt}`);

  const prompt = sections.join('\n\n---\n\n');
  return _annotatePrompt(prompt, { fullContextLoaded: true, contextFileCount: contextFilePaths.length });
}

// ─── Noise Detection ──────────────────────────────────────────────────────────

/**
 * Analyses a prompt for noise and hallucination risk.
 * Emits warnings when token count exceeds the threshold.
 *
 * @param {string} prompt
 * @returns {NoiseAnalysis}
 */
function analysePromptNoise(prompt) {
  const estimatedTokens = estimateTokens(prompt);
  const isHighRisk = estimatedTokens > LLM.HALLUCINATION_RISK_THRESHOLD;

  const analysis = {
    estimatedTokens,
    isHighRisk,
    riskLevel: _getRiskLevel(estimatedTokens),
    recommendations: [],
  };

  if (isHighRisk) {
    analysis.recommendations.push(
      `Token count (${estimatedTokens}) exceeds hallucination risk threshold (${LLM.HALLUCINATION_RISK_THRESHOLD}).`
    );
    analysis.recommendations.push(`Consider: (1) Use thick tools to summarise context, (2) Remove irrelevant sections, (3) Split into multiple focused prompts.`);

    console.warn(
      `\n⚠️  [PromptBuilder] HALLUCINATION RISK DETECTED\n` +
      `   Estimated tokens: ${estimatedTokens}\n` +
      `   Threshold: ${LLM.HALLUCINATION_RISK_THRESHOLD}\n` +
      `   Risk level: ${analysis.riskLevel}\n` +
      `   Recommendation: ${analysis.recommendations[1]}\n`
    );
  }

  return analysis;
}

function _getRiskLevel(tokens) {
  if (tokens < LLM.HALLUCINATION_RISK_THRESHOLD * 0.5) return 'low';
  if (tokens < LLM.HALLUCINATION_RISK_THRESHOLD) return 'medium';
  if (tokens < LLM.HALLUCINATION_RISK_THRESHOLD * 2) return 'high';
  return 'critical';
}

// ─── Cached ContextLoader instance (D1 optimisation) ─────────────────────────
// buildAgentPrompt() is called once per LLM invocation. Previously, each call
// created a brand-new ContextLoader, which meant scanning skill files from disk
// every time. Now we cache the loader and only recreate it when options change.
let _cachedLoader = null;
let _cachedLoaderKey = '';

/**
 * Callback list for one-shot notifications when _cachedLoader is first created.
 * Used by orchestrator-lifecycle.js to start SkillWatcher once ContextLoader exists.
 * @type {Function[]}
 */
let _onLoaderCreatedCallbacks = [];

/**
 * Module-level PromptSlotManager instance.
 * Initialised lazily on first buildAgentPrompt() call, or eagerly via
 * setPromptSlotManager(). When set, buildAgentPrompt() resolves the fixed
 * prefix from the variant registry instead of using the hardcoded
 * AGENT_FIXED_PREFIXES constant.
 *
 * @type {PromptSlotManager|null}
 */
let _promptSlotManager = null;

/**
 * Module-level SelfReflectionEngine reference.
 * When set, buildAgentPrompt() auto-injects the known-issues summary into
 * every agent prompt, making agents aware of recurring problems.
 *
 * @type {SelfReflectionEngine|null}
 */
let _selfReflectionEngine = null;

/**
 * Module-level SkillEvolutionEngine reference.
 * When set, ContextLoader uses this to dynamically fetch retired skill names
 * at load time, ensuring retired skills are excluded from prompt injection.
 *
 * @type {SkillEvolutionEngine|null}
 */
let _skillEvolutionEngine = null;

/**
 * Module-level ExperienceStore reference.
 * When set, buildAgentPrompt() uses the synonym table to expand queries
 * for better skill matching and context retrieval.
 *
 * @type {ExperienceStore|null}
 */
let _experienceStore = null;

/**
 * Module-level Orchestrator reference (ADR-45).
 * When set, ContextLoader can trigger lazy skill enrichment when it detects
 * placeholder skills during loading.
 *
 * @type {object|null}
 */
let _orchestrator = null;

/**
 * Sets the module-level SelfReflectionEngine reference.
 * Called by Orchestrator during initialisation.
 *
 * @param {SelfReflectionEngine} engine
 */
function setSelfReflectionEngine(engine) {
  _selfReflectionEngine = engine;
}

/**
 * Sets the module-level SkillEvolutionEngine reference.
 * Called by Orchestrator during initialisation.
 * The engine's registry is queried to build the retiredSkills set for ContextLoader.
 *
 * @param {SkillEvolutionEngine} engine
 */
function setSkillEvolutionEngine(engine) {
  _skillEvolutionEngine = engine;
}

/**
 * Sets the module-level ExperienceStore reference.
 * Called by Orchestrator during initialisation.
 * Used to access the synonym table for query expansion.
 *
 * @param {ExperienceStore} store
 */
function setExperienceStore(store) {
  _experienceStore = store;
}

/**
 * Sets the module-level Orchestrator reference (ADR-45).
 * Called by Orchestrator during initialisation.
 * Used by ContextLoader for lazy skill enrichment.
 *
 * @param {object} orch
 */
function setOrchestrator(orch) {
  _orchestrator = orch;
}

/**
 * Module-level EmbeddingService reference (Plan-C).
 * Set by Orchestrator during initialisation.
 * Passed to ContextLoader for semantic skill matching.
 * @type {import('./embedding-service').EmbeddingService|null}
 */
let _embeddingService = null;

/**
 * Module-level cheap LLM call for ContextLoader ADR digest enhancement.
 * Injected by Orchestrator during initialisation via setContextLoaderCheapLlm().
 * @type {Function|null}
 */
let _contextLoaderCheapLlm = null;

/**
 * Module-level ExperienceStore reference for ContextLoader Prevention Rule injection.
 * Injected by Orchestrator during initialisation via setContextLoaderExperienceStore().
 * ADR-55: MemGPT retrieval pattern — retrieve relevant memories on demand.
 * @type {object|null}
 */
let _contextLoaderExperienceStore = null;

/**
 * Sets the module-level EmbeddingService reference (Plan-C).
 * Called by Orchestrator during initialisation.
 *
 * @param {import('./embedding-service').EmbeddingService} service
 */
function setEmbeddingService(service) {
  _embeddingService = service;
}

/**
 * Sets the module-level cheap LLM call for ContextLoader ADR digest.
 * Called by Orchestrator during initialisation.
 *
 * @param {Function} llmCall - Async function: (prompt: string) => string
 */
function setContextLoaderCheapLlm(llmCall) {
  if (typeof llmCall === 'function') {
    _contextLoaderCheapLlm = llmCall;
    // Inject into cached loader if already created
    if (_cachedLoader && typeof _cachedLoader.setCheapLlmCall === 'function') {
      _cachedLoader.setCheapLlmCall(llmCall);
    }
  }
}

/**
 * Sets the module-level ExperienceStore for ContextLoader Prevention Rule injection.
 * Called by Orchestrator during initialisation.
 * ADR-55: MemGPT retrieval pattern — retrieve relevant memories on demand.
 *
 * @param {object} store - ExperienceStore instance
 */
function setContextLoaderExperienceStore(store) {
  _contextLoaderExperienceStore = store || null;
  // Inject into cached loader if already created
  if (_cachedLoader) {
    _cachedLoader._experienceStore = _contextLoaderExperienceStore;
  }
}

/**
 * Sets the module-level PromptSlotManager instance.
 * Called by Orchestrator during initialisation.
 *
 * @param {PromptSlotManager} mgr
 */
function setPromptSlotManager(mgr) {
  _promptSlotManager = mgr;
}

/**
 * Returns the current PromptSlotManager instance (or null).
 * Exposed so orchestrator-stages.js can call recordOutcome().
 *
 * @returns {PromptSlotManager|null}
 */
function getPromptSlotManager() {
  return _promptSlotManager;
}

/**
 * Returns the cached ContextLoader instance (or null if none exists yet).
 * Exposed so orchestrator-lifecycle.js can pass it to SkillWatcher for
 * cache invalidation without creating a second ContextLoader.
 *
 * @returns {ContextLoader|null}
 */
function getCachedLoader() {
  return _cachedLoader;
}

/**
 * Registers a one-shot callback that fires when _cachedLoader is first created.
 * If _cachedLoader already exists, the callback fires synchronously.
 * Used by orchestrator-lifecycle.js to start SkillWatcher after ContextLoader is ready.
 *
 * @param {Function} cb - (loader: ContextLoader) => void
 */
function onLoaderReady(cb) {
  if (typeof cb !== 'function') return;
  if (_cachedLoader) {
    // Already created – fire immediately
    cb(_cachedLoader);
  } else {
    _onLoaderCreatedCallbacks.push(cb);
  }
}

/**
 * Extracts retired skill names from SkillEvolutionEngine registry.
 * Returns a Set of skill names that have a non-null retiredAt timestamp.
 *
 * @param {SkillEvolutionEngine} engine
 * @returns {Set<string>}
 * @private
 */
function _getRetiredSkillNames(engine) {
  const retired = new Set();
  try {
    for (const meta of engine.registry.values()) {
      if (meta.retiredAt) {
        retired.add(meta.name);
      }
    }
  } catch (_) { /* non-fatal: engine may not be fully initialised */ }
  return retired;
}

/**
 * Returns a (possibly cached) ContextLoader instance.
 * Recreates only if the options fingerprint changes.
 *
 * Note: retiredSkills are intentionally excluded from the cache key.
 * Instead, the Set is passed through to ContextLoader on every creation,
 * and ContextLoader checks it at match/load time. Since retiredSkills is a
 * Set reference that updates in place (from SkillEvolutionEngine registry),
 * the same ContextLoader instance automatically sees the latest retirements.
 * @private
 */
function _getOrCreateLoader(options) {
  const key = JSON.stringify([
    options.workflowRoot,
    options.projectRoot,
    Object.keys(options.skillKeywords || {}),
    options.alwaysLoadSkills,
    options.globalSkills,
    options.projectSkills,
    options.riskProfile || null,
  ]);
  if (_cachedLoader && _cachedLoaderKey === key) {
    // Gap 1 fix: update retiredSkills even on cache hit, so newly-retired skills
    // are excluded without recreating the entire ContextLoader.
    if (options.retiredSkills) {
      _cachedLoader._retiredSkills = options.retiredSkills instanceof Set
        ? options.retiredSkills
        : new Set(options.retiredSkills || []);
    }
    // P0: update codeGraph reference on cache hit (instance may change between calls)
    if (options.codeGraph) {
      _cachedLoader._codeGraph = options.codeGraph;
    }
    // ADR-45: update orchestrator reference on cache hit (for lazy enrichment)
    if (options.orchestrator) {
      _cachedLoader._orchestrator = options.orchestrator;
    }
    // Plan-C: update embeddingService reference on cache hit
    if (options.embeddingService) {
      _cachedLoader._embeddingService = options.embeddingService;
      // ADR-OpenSpace: also update SkillRanker's embedding reference
      if (_cachedLoader._skillRanker) {
        _cachedLoader._skillRanker.setEmbeddingService(options.embeddingService);
      }
    }
    // P1.5: update risk profile on cache hit for risk-driven skill packs
    if (options.riskProfile && typeof options.riskProfile === 'object') {
      _cachedLoader._riskProfile = options.riskProfile;
    } else {
      _cachedLoader._riskProfile = null;
    }
    // ADR-55: update experienceStore reference on cache hit (Prevention Rule injection)
    if (_contextLoaderExperienceStore) {
      _cachedLoader._experienceStore = _contextLoaderExperienceStore;
    }
    // Inject cheap LLM call on cache hit (in case it was set after loader creation)
    if (_contextLoaderCheapLlm && typeof _cachedLoader.setCheapLlmCall === 'function' && !_cachedLoader._cheapLlmCall) {
      _cachedLoader.setCheapLlmCall(_contextLoaderCheapLlm);
    }
    return _cachedLoader;
  }
  const isFirstCreation = !_cachedLoader;
  _cachedLoader = new ContextLoader(options);
  _cachedLoaderKey = key;

  // Inject cheap LLM call into newly created loader
  if (_contextLoaderCheapLlm && typeof _cachedLoader.setCheapLlmCall === 'function') {
    _cachedLoader.setCheapLlmCall(_contextLoaderCheapLlm);
  }

  // ADR-55: inject experienceStore into newly created loader (Prevention Rule injection)
  if (_contextLoaderExperienceStore) {
    _cachedLoader._experienceStore = _contextLoaderExperienceStore;
  }

  // Fire one-shot callbacks when ContextLoader is first created.
  // This allows deferred SkillWatcher startup from orchestrator-lifecycle.js.
  if (isFirstCreation && _onLoaderCreatedCallbacks.length > 0) {
    const cbs = _onLoaderCreatedCallbacks;
    _onLoaderCreatedCallbacks = [];
    for (const cb of cbs) {
      try { cb(_cachedLoader); } catch (_) { /* non-fatal */ }
    }
  }

  return _cachedLoader;
}

// ─── Agent Prompt Templates ───────────────────────────────────────────────────

/**
 * Pre-built KV-Cache-optimised fixed prefixes for each agent role.
 * These are the STATIC parts that benefit most from KV caching.
 */
// ─── Session Start Checklist ─────────────────────────────────────────────────

/**
 * Builds a structured Session Start Checklist prompt section.
 * Inspired by the "long-running agent" pattern: each coding session must begin
 * with a fixed orientation sequence to prevent context loss across sessions.
 *
 * The checklist enforces:
 *  1. Confirm working directory
 *  2. Read progress file + task list to understand current state
 *  3. Check recent git log for undocumented changes
 *  4. Run init script to start dev server (if applicable)
 *  5. Run basic smoke test to verify environment health
 *  6. Select ONE pending task to work on
 *
 * @param {object} [options]
 * @param {string}  [options.progressFile]  - Path to progress/manifest file (default: manifest.json)
 * @param {string}  [options.taskFile]      - Path to task list file (default: tasks.json)
 * @param {string}  [options.initScript]    - Path to init script (default: none)
 * @param {boolean} [options.requireSmokeTest=false] - Whether to require a smoke test step
 * @returns {string} - The checklist prompt section (plain text, ready to inject)
 */
function buildSessionStartChecklist(options = {}) {
  const {
    progressFile = 'manifest.json',
    taskFile = 'output/tasks.json',
    featureListFile = null,
    initScript = null,
    requireSmokeTest = false,
  } = options;

  const steps = [
    `STEP 1 – Confirm working directory: Run \`pwd\` (or \`cd\` on Windows). You may ONLY edit files within this directory.`,
    `STEP 2 – Read progress state: Read \`${progressFile}\` and \`${taskFile}\` to understand what has been done and what remains.` +
      (featureListFile ? ` Also read \`${featureListFile}\` for the feature completion status.` : ''),
    `STEP 3 – Review recent git history: Run \`git log --oneline -20\` to identify any undocumented changes from previous sessions.`,
  ];

  if (initScript) {
    steps.push(`STEP 4 – Start environment: Read \`${initScript}\` to understand the startup process. If it starts a dev server, run it in background (\`bash ${initScript} &\`) or skip the server step — do NOT let it block. If the script might hang, prefer reading it with \`read_file\` and running only the safe parts.`);
  }

  if (requireSmokeTest) {
    const stepNum = initScript ? 5 : 4;
    steps.push(`STEP ${stepNum} – Smoke test: Run a basic end-to-end test to verify the environment is healthy. If the environment is broken, fix it BEFORE starting new work.`);
  }

  const lastStep = steps.length + 1;
  const featureOrTask = featureListFile
    ? `Read \`${featureListFile}\`, find the highest-priority feature where \`passes: false\`, and work on it exclusively.`
    : `Read the task list, identify the highest-priority pending task, and work on it exclusively.`;
  steps.push(
    `STEP ${lastStep} – Select ONE task: ${featureOrTask}` +
    ` Do NOT claim or start a second task until the first is committed and marked done.`
  );

  const checklist = [
    `## Session Start Checklist (MANDATORY)`,
    ``,
    `Every session MUST begin with the following steps in order. Do not skip any step.`,
    ``,
    ...steps.map(s => `- ${s}`),
    ``,
    `⚠️  CRITICAL RULES:`,
    `- Work on ONE task at a time. Attempting multiple tasks simultaneously causes context loss and is NOT acceptable.`,
    `- Do NOT mark a task as done without providing a verificationNote describing how you tested the change.`,
    `- If the environment is broken at session start, fix it first before implementing new features.`,
  ].join('\n');

  return checklist;
}

/**
 * Output style presets for controlling agent response format.
 * These styles are injected into the fixed prefix to guide LLM output.
 */
const OUTPUT_STYLES = {
  concise: {
    description: 'Brief, focused responses with minimal explanation',
    instruction: `
## Output Style: CONCISE

- Provide ONLY the essential information
- Use bullet points for lists
- Omit explanatory text unless explicitly requested
- Code: Show only the modified lines with minimal context
- Max response length: Aim for under 500 tokens
`,
  },
  verbose: {
    description: 'Detailed responses with full explanation',
    instruction: `
## Output Style: VERBOSE

- Provide comprehensive explanations
- Include reasoning for each decision
- Show full context around code changes
- Add examples where helpful
- Feel free to use full response length as needed
`,
  },
  structured: {
    description: 'Strictly formatted responses with sections',
    instruction: `
## Output Style: STRUCTURED

ALWAYS use this exact structure:

### Summary
One-line summary of findings/actions

### Details
- Point 1
- Point 2
...

### Actions Taken (if applicable)
1. Step 1
2. Step 2
...

### Verification
How to verify the changes work correctly

### Next Steps (optional)
What should happen next
`,
  },
  analytical: {
    description: 'Analytical responses with pros/cons and tradeoffs',
    instruction: `
## Output Style: ANALYTICAL

- Present multiple perspectives where applicable
- Include pros/cons for significant decisions
- Discuss tradeoffs explicitly
- Reference relevant patterns or principles
- Conclude with a clear recommendation
`,
  },
  stepByStep: {
    description: 'Sequential numbered steps with clear progression',
    instruction: `
## Output Style: STEP-BY-STEP

- Break down into numbered steps (1, 2, 3...)
- Each step must be actionable and specific
- Confirm completion of each step before proceeding
- Show intermediate results if applicable
- End with verification of complete sequence
`,
  },
};

// ─── Pattern Library Integration (P2) ────────────────────────────────────────

/**
 * Module-level Pattern Library instance.
 * Lazily initialized on first access.
 * @type {PromptPatternLibrary|null}
 */
let _patternLibrary = null;

/**
 * Returns the singleton Pattern Library instance.
 * @returns {PromptPatternLibrary}
 */
function _getPatternLibrary() {
  if (!_patternLibrary) {
    _patternLibrary = createWorkflowPatternLibrary();
  }
  return _patternLibrary;
}

/**
 * Pattern configurations for different agent roles.
 * Maps role to default patterns that should be applied.
 */
const ROLE_PATTERNS = {
  analyst: ['chain-of-thought', 'structured-output'],
  architect: ['chain-of-thought', 'analytical', 'verification-loop'],
  developer: ['session-checkpoint', 'structured-output', 'verification-loop'],
  tester: ['structured-output', 'tool-use', 'session-checkpoint'],
  'coding-agent': ['session-checkpoint', 'tool-use', 'structured-output', 'verification-loop'],
  pm: ['chain-of-thought', 'structured-output'],
};

/**
 * Applies pattern library templates to the fixed prefix.
 * Integrates with PromptBuilder's output style system.
 *
 * @param {string} role - Agent role
 * @param {string} fixedPrefix - Base fixed prefix
 * @param {object} [options]
 * @param {string[]} [options.patterns] - Explicit patterns to use
 * @param {object} [options.patternParams] - Pattern parameters
 * @returns {string} Enhanced prefix with patterns applied
 */
function _applyPatterns(role, fixedPrefix, options = {}) {
  const library = _getPatternLibrary();

  // Determine which patterns to apply
  let patternNames = options.patterns;
  if (!patternNames) {
    patternNames = ROLE_PATTERNS[role] || ['structured-output'];
  }

  // Build pattern sections
  const patternSections = [];
  for (const name of patternNames) {
    const pattern = library.getPattern(name, options.patternParams?.[name] || {});
    if (pattern) {
      const parts = [];
      if (pattern.prefix) parts.push(pattern.prefix);
      if (pattern.structure) parts.push(pattern.structure);
      if (pattern.suffix) parts.push(pattern.suffix);
      patternSections.push(parts.join('\n\n'));
    }
  }

  // Compose final prefix: original + patterns
  if (patternSections.length === 0) {
    return fixedPrefix;
  }

  return fixedPrefix + '\n\n===\n\n' + patternSections.join('\n\n---\n\n');
}

/**
 * Pre-populates the ContextLoader's ADR digest cache using cheap LLM.
 * Must be called (and awaited) BEFORE buildAgentPrompt() so that the
 * synchronous resolve() path can use the cached LLM digest.
 *
 * Safe to call when no cheapLlmCall is configured — returns immediately.
 * Safe to call multiple times — the cache prevents redundant LLM calls.
 *
 * @param {string} taskText - The current task description
 * @param {object} [options] - Same options as buildAgentPrompt
 * @returns {Promise<void>}
 */
async function preloadAdrDigest(taskText, options = {}) {
  if (!_contextLoaderCheapLlm || !taskText) return;

  try {
    const loaderOptions = {
      workflowRoot:     WORKFLOW_ROOT,
      projectRoot:      options && options.projectRoot ? options.projectRoot : null,
      skillKeywords:    options && options.skillKeywords ? options.skillKeywords : {},
      alwaysLoadSkills: options && options.alwaysLoadSkills ? options.alwaysLoadSkills : [],
      globalSkills:     options && options.globalSkills ? options.globalSkills : (getConfig().globalSkills || []),
      projectSkills:    options && options.projectSkills ? options.projectSkills : (getConfig().projectSkills || []),
      retiredSkills:    _skillEvolutionEngine ? _getRetiredSkillNames(_skillEvolutionEngine) : null,
      codeGraph:        options && options.codeGraph ? options.codeGraph : null,
      orchestrator:     _orchestrator,
      embeddingService: _embeddingService,
      riskProfile:      options && options.riskProfile ? options.riskProfile : null,
    };
    const loader = _getOrCreateLoader(loaderOptions);
    if (!loader._cheapLlmCall) return;

    // Read decision-log.md (same path as ContextLoader uses)
    const logPath = nodePath.join(WORKFLOW_ROOT, 'docs', 'decision-log.md');
    if (!fs.existsSync(logPath)) return;

    const logContent = fs.readFileSync(logPath, 'utf-8');
    if (!logContent || logContent.length < 50) return;

    // ADR token budget: 600 tokens (same as MAX_ADR_TOKENS in context-loader-config)
    await loader.preloadAdrDigest(logContent, taskText, 600);
  } catch (err) {
    // Non-fatal: buildAgentPrompt will fall back to heuristic ADR extraction
    console.warn(`[PromptBuilder] ⚠️ preloadAdrDigest failed (non-fatal): ${err.message}`);
  }
}

/**
 * Builds a complete, optimised prompt for a specific agent role.
 *
 * @param {string} role         - Agent role (analyst|architect|developer|tester)
 * @param {string} dynamicInput - The dynamic input content for this call
 * @param {string[]} [contextFiles] - Additional context file paths
 * @param {object} [options]
 * @param {string} [options.outputStyle] - Output style: 'concise'|'verbose'|'structured'|'analytical'|'stepByStep'
 * @param {boolean} [options.usePatterns=true] - Whether to apply Pattern Library templates
 * @param {string[]} [options.patterns] - Explicit patterns to use (overrides role defaults)
 * @param {object} [options.patternParams] - Pattern-specific parameters
 * @param {boolean} [options.trackMetrics=true] - Whether to log timing metrics
 * @returns {Promise<{ prompt: string, meta: PromptMeta }>}
 */
async function buildAgentPrompt(role, dynamicInput, contextFiles = [], options = {}) {
  // P1-6 fix: refactored from 200-line monolith into a coordinator that
  // delegates to focused helper functions, each handling one phase.

  // Phase 1: Resolve fixed prefix (A/B testing + output style)
  let { fixedPrefix, _resolvedVariantId, _isExploration } = _resolveFixedPrefix(role);

// P3: Inject output style instruction if specified
  if (options.outputStyle && OUTPUT_STYLES[options.outputStyle]) {
    fixedPrefix = fixedPrefix + '\n\n' + OUTPUT_STYLES[options.outputStyle].instruction;
  }

  // P2: Apply Pattern Library templates (unless explicitly disabled)
  if (options.usePatterns !== false) {
    const patternStartTime = Date.now();
    fixedPrefix = _applyPatterns(role, fixedPrefix, {
      patterns: options.patterns,
      patternParams: options.patternParams,
    });
    if (options.trackMetrics !== false) {
      console.log(`[PromptBuilder] Patterns applied in ${Date.now() - patternStartTime}ms`);
    }
  }

  // Phase 2: Collect explicit context file sections
  const autoContextFiles = _prepareContextFiles(role, contextFiles, options);

  // Phase 3: Load skills + ADR digest via ContextLoader
  const { autoSections, injectedSkillNames } = await _loadAutoInjectedSections(role, dynamicInput, options);

  // Phase 4: Read context files from disk
  const contextSections = _readContextFileSections(autoContextFiles);

  // Phase 5: Inject runtime environment info + self-reflection + IDE tool guidance + self-report
  _injectRuntimeInfo(autoSections);
  _injectIDEToolGuidance(autoSections);
  _injectSelfReflection(autoSections, options);
  _injectAgentSelfReportInstruction(autoSections, role);

  // Phase 6: Assemble and apply degradation
  let dynamicSuffix = [...autoSections, ...contextSections, `### Input\n${dynamicInput}`].join('\n\n');
  let result = buildKVCacheFriendlyPrompt(fixedPrefix, dynamicSuffix);

  const noiseAnalysis = analysePromptNoise(result.prompt);
  if (noiseAnalysis.isHighRisk && (autoSections.length > 0 || contextSections.length > 0)) {
    result = _applyContextDegradation(fixedPrefix, dynamicInput, autoSections, contextSections, role);
    result.meta.contextDegraded = true;
  }

  // Phase 7: Attach metadata
  result.meta.noiseAnalysis = result.meta.contextDegraded
    ? analysePromptNoise(result.prompt)
    : noiseAnalysis;
  result.meta.agentRole = role;
  if (options.outputStyle) {
    result.meta.outputStyle = options.outputStyle;
  }
  if (injectedSkillNames && injectedSkillNames.length > 0) {
    result.meta.injectedSkillNames = injectedSkillNames;
    // Introspection logging for skill injection
    for (const skillName of injectedSkillNames) {
      introspectionCollector.recordPrompt('injected', {
        skillName,
        agentRole: role,
        contextDegraded: result.meta.contextDegraded || false,
      });
    }
  }
  if (_resolvedVariantId) {
    result.meta.promptVariantId = _resolvedVariantId;
    result.meta.promptVariantExploration = _isExploration;
  }

  return result;
}

// ─── buildAgentPrompt helper functions (P1-6 SRP extraction) ────────────────

/**
 * Phase 1: Resolve the fixed prefix, supporting A/B testing via PromptSlotManager.
 */
function _resolveFixedPrefix(role) {
  let fixedPrefix = AGENT_FIXED_PREFIXES[role];
  let _resolvedVariantId = null;
  let _isExploration = false;

  if (_promptSlotManager) {
    const resolved = _promptSlotManager.resolve(role, 'fixed_prefix');
    if (resolved && resolved.content) {
      fixedPrefix = resolved.content;
      _resolvedVariantId = resolved.variantId;
      _isExploration = resolved.isExploration;
      if (_isExploration) {
        console.log(`[PromptBuilder] 🔬 A/B exploration: using variant "${resolved.variantId}" for ${role}`);
      }
    }
  }

  if (!fixedPrefix) {
    const validRoles = Object.keys(AGENT_FIXED_PREFIXES).join(', ');
    throw new Error(`[PromptBuilder] Unknown agent role: "${role}". Valid roles: ${validRoles}`);
  }

  return { fixedPrefix, _resolvedVariantId, _isExploration };
}

/**
 * Phase 2: Prepare the list of context files, auto-injecting feature-list.json
 * for coding-agent if available.
 */
function _prepareContextFiles(role, contextFiles, options) {
  const autoContextFiles = [...contextFiles];
  if (role === 'coding-agent') {
    const projectRoot = (options && options.projectRoot)
      ? options.projectRoot
      : WORKFLOW_ROOT;
    const featureListPath = nodePath.join(projectRoot, 'output', 'feature-list.json');
    const alreadyIncluded = autoContextFiles.some(f => nodePath.basename(f) === 'feature-list.json');
    if (!alreadyIncluded && fs.existsSync(featureListPath)) {
      autoContextFiles.unshift(featureListPath);
    }
  }
  return autoContextFiles;
}

/**
 * Phase 3: Load auto-injected sections (skills + ADR digest) via ContextLoader.
 */
async function _loadAutoInjectedSections(role, dynamicInput, options) {
  // P1 fix: expand query with synonyms before passing to ContextLoader
  const expandedInput = _expandQueryWithSynonyms(dynamicInput);

  const loaderOptions = {
    workflowRoot:     WORKFLOW_ROOT,
    projectRoot:      options && options.projectRoot ? options.projectRoot : null,
    skillKeywords:    options && options.skillKeywords ? options.skillKeywords : {},
    alwaysLoadSkills: options && options.alwaysLoadSkills ? options.alwaysLoadSkills : [],
    globalSkills:     options && options.globalSkills ? options.globalSkills : (getConfig().globalSkills || []),
    projectSkills:    options && options.projectSkills ? options.projectSkills : (getConfig().projectSkills || []),
    retiredSkills:    _skillEvolutionEngine ? _getRetiredSkillNames(_skillEvolutionEngine) : null,
    codeGraph:        options && options.codeGraph ? options.codeGraph : null,
    orchestrator:     _orchestrator,  // ADR-45: for lazy skill enrichment
    embeddingService: _embeddingService, // Plan-C: for semantic skill matching
    riskProfile:      options && options.riskProfile ? options.riskProfile : null, // P1.5: diff risk driven skill packs
  };
  const loader = _getOrCreateLoader(loaderOptions);
  const { sections: autoSections, sources: autoSources } = await loader.resolve(expandedInput, role);

  const injectedSkillNames = (autoSources || [])
    .filter(s => s.endsWith('.md') && !s.includes('decision-log') && !s.includes('architecture-constraints') && !s.includes('code-graph'))
    .map(s => s.replace(/\.md$/, '').replace(/\s*\(.*\)$/, ''));

  return { autoSections, injectedSkillNames };
}

/**
 * P1 fix: Expands query text with synonyms from the ExperienceStore synonym table.
 * This improves skill matching recall by including related terms.
 *
 * @param {string} query - Original query text
 * @returns {string} - Expanded query with synonyms appended
 */
function _expandQueryWithSynonyms(query) {
  if (!_experienceStore || typeof query !== 'string') return query;

  try {
    const synonymTable = _experienceStore.getSynonymTable();
    if (!synonymTable || Object.keys(synonymTable).length === 0) return query;

    const lower = query.toLowerCase();
    const expandedTerms = new Set();

    // Find matching entries and collect their expanded terms
    for (const [key, entry] of Object.entries(synonymTable)) {
      const keywords = key.split('|');
      for (const kw of keywords) {
        if (lower.includes(kw.toLowerCase())) {
          for (const term of (entry.expandedTerms || [])) {
            expandedTerms.add(term);
          }
          break; // Only count each entry once
        }
      }
    }

    if (expandedTerms.size === 0) return query;

    // Append expanded terms (limit to avoid bloat)
    const termsArray = [...expandedTerms].slice(0, 10);
    const expanded = `${query} ${termsArray.join(' ')}`;

    if (termsArray.length > 0) {
      console.log(`[PromptBuilder] 🔍 Query expanded with ${termsArray.length} synonym(s): ${termsArray.slice(0, 5).join(', ')}${termsArray.length > 5 ? '...' : ''}`);
    }

    return expanded;
  } catch (err) {
    console.warn(`[PromptBuilder] Query expansion failed: ${err.message}`);
    return query; // Non-fatal: return original query on error
  }
}

/**
 * Phase 4: Read explicit context files into sections.
 */
function _readContextFileSections(contextFilePaths) {
  const sections = [];
  for (const filePath of contextFilePaths) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      sections.push(`### Context: ${nodePath.basename(filePath)}\n${content}`);
    }
  }
  return sections;
}

/**
 * Phase 5a: Inject runtime environment info (OS, shell).
 */
function _injectRuntimeInfo(autoSections) {
  try {
    const osType = process.platform;
    const shellHint = osType === 'win32' ? 'PowerShell' : (process.env.SHELL || '/bin/bash');
    const envLines = [
      `### Runtime Environment`,
      `- **OS**: ${osType === 'win32' ? 'Windows' : osType === 'darwin' ? 'macOS' : 'Linux'}`,
      `- **Shell**: ${shellHint}`,
    ];
    if (osType === 'win32') {
      envLines.push(
        `- **CRITICAL Shell Rules**:`,
        `  - Do NOT use \`&&\` to chain commands (PowerShell does not support it). Use \`;\` or separate commands.`,
        `  - Use \`Get-ChildItem\` instead of \`ls\`, \`Select-String\` instead of \`grep\`.`,
        `  - Use backslash \`\\\` for path separators, or forward slash \`/\` (both work in PowerShell).`,
        `  - Use \`$env:VAR\` instead of \`$VAR\` for environment variables.`,
      );
    }
    autoSections.push(envLines.join('\n'));
  } catch (_) { /* Non-fatal */ }
}

/**
 * Phase 5a-IDE: Inject IDE tool guidance when running inside an IDE.
 * Instructs AI Agents to prefer IDE-native tools (codebase_search, grep_search,
 * view_code_item) over self-built modules (CodeGraph.search, LSPAdapter) for
 * maximum accuracy and speed. Self-built modules remain available as fallback.
 *
 * ADR-37 Update: CodeGraph.querySymbol() now automatically prioritizes
 * IDE's view_code_item when available, falling back to regex parsing on failure.
 * This ensures maximum symbol accuracy (~100% via LSP vs ~80% via regex).
 */
function _injectIDEToolGuidance(autoSections) {
  try {
    const guidance = generateIDEToolGuidance();
    if (guidance) {
      autoSections.push(guidance);
      // Add note about automatic IDE priority in CodeGraph
      autoSections.push(`
> 💡 **Implementation Note**: \`CodeGraph.querySymbol()\` automatically uses IDE's \`view_code_item\` 
> when available (ADR-37), falling back to regex parsing only on failure. This provides 
> compiler-accurate symbol resolution (~100% accuracy) instead of regex-based approximation (~80%).`);
    }
  } catch (_) { /* Non-fatal: IDE guidance is optional enhancement */ }
}

/**
 * Phase 5b: Inject self-reflection known-issues summary.
 */
function _injectSelfReflection(autoSections, options) {
  if (_selfReflectionEngine) {
    try {
      const reflectionSummary = _selfReflectionEngine.getReflectionSummary(1500);
      if (reflectionSummary) {
        autoSections.push(`### Known Issues (Self-Reflection)\n${reflectionSummary}`);
      }
    } catch (_) { /* Non-fatal */ }
  } else if (options && options.selfReflectionSummary) {
    autoSections.push(`### Known Issues (Self-Reflection)\n${options.selfReflectionSummary}`);
  }
}

/**
 * Phase 5c: Inject Agent Self-Report instruction when running in IDE Agent mode.
 *
 * This asks the Agent to emit a structured JSON block at the end of its output,
 * reporting confidence, decisions, files touched, and blockers.
 * Only injected when IDE is detected (to avoid wasting tokens in CLI/standalone mode
 * where Observability already captures this data via hooks).
 *
 * Cost: ~400 tokens of prompt space. Benefit: fills the IDE-mode observability gap.
 */
function _injectAgentSelfReportInstruction(autoSections, role) {
  try {
    const ideResult = getIDEDetectionResult();
    if (ideResult.isInsideIDE) {
      autoSections.push(SELF_REPORT_INSTRUCTION);
    }
  } catch (_) { /* Non-fatal: self-report instruction is optional enhancement */ }
}

/**
 * Phase 6 (degradation): Delegated to prompt-context-degradation.js (ADR-33 Phase 4).
 */
const { applyContextDegradation } = require('./prompt-context-degradation');

function _applyContextDegradation(fixedPrefix, dynamicInput, autoSections, contextSections, role = null) {
  return applyContextDegradation(fixedPrefix, dynamicInput, autoSections, contextSections, role, buildKVCacheFriendlyPrompt, analysePromptNoise);
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function _annotatePrompt(prompt, extraMeta = {}) {
  const estimatedTokens = estimateTokens(prompt);
  return {
    prompt,
    meta: {
      estimatedTokens,
      charCount: prompt.length,
      ...extraMeta,
    },
  };
}

module.exports = {
  buildKVCacheFriendlyPrompt,
  buildFullContextPrompt,
  analysePromptNoise,
  buildAgentPrompt,
  buildSessionStartChecklist,
  AGENT_FIXED_PREFIXES,
  // Prompt A/B testing
  setPromptSlotManager,
  getPromptSlotManager,
  // ContextLoader access (for SkillWatcher integration)
  getCachedLoader,
  // Deferred SkillWatcher startup
  onLoaderReady,
  // Self-Reflection context injection
  setSelfReflectionEngine,
  // Skill Evolution context injection (Gap 1: retired skill exclusion)
  setSkillEvolutionEngine,
  // ExperienceStore for synonym expansion (P1 fix)
  setExperienceStore,
  // Orchestrator reference for lazy skill enrichment (ADR-45)
  setOrchestrator,
  // Plan-C: EmbeddingService for semantic skill matching
  setEmbeddingService,
  // Cheap LLM for ContextLoader ADR digest
  setContextLoaderCheapLlm,
  // ADR-55: ExperienceStore for ContextLoader Prevention Rule injection (MemGPT retrieval pattern)
  setContextLoaderExperienceStore,
  preloadAdrDigest,
// P3: Output style constants and helpers
  OUTPUT_STYLES,
  // P2: Pattern Library integration
  /**
   * Get the Pattern Library instance for advanced pattern operations.
   * @returns {import('./prompt-pattern-library').PromptPatternLibrary}
   */
  getPatternLibrary: _getPatternLibrary,
  /**
   * Role-to-patterns mapping for customization.
   * Modify this to change default patterns for each role.
   */
  ROLE_PATTERNS,
  // Long-running agent pattern modules
  FeatureList:    require('./feature-list').FeatureList,
  FeatureStatus:  require('./feature-list').FeatureStatus,
  FeatureCategory: require('./feature-list').FeatureCategory,
  GitIntegration: require('./git-integration').GitIntegration,
};
