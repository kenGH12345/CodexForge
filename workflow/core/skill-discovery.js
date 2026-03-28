/**
 * Skill Discovery — Auto-discover project conventions from code artifacts
 *
 * Solves the cold-start problem: when an Agent enters a new project with zero
 * experience records and no project-specific skills, it has no knowledge of
 * the project's conventions, patterns, or toolchain.
 *
 * Architecture:
 *   1. Rule Scanner (zero LLM calls): scans well-known config files
 *      (AGENTS.md, .eslintrc, package.json, tsconfig.json, Makefile, etc.)
 *      and extracts structured convention signals.
 *   2. LLM Refiner (1 LLM call, ~2000 tokens): consolidates extracted signals
 *      into a coherent project-standards skill document.
 *   3. Skill Registration: registers the generated skill via SkillEvolutionEngine
 *      so it participates in the normal skill lifecycle (injection, evolution, QualityGate).
 *
 * Storage: project-specific skills are stored in <projectRoot>/.workflow/skills/
 * (NOT in workflow/skills/) to maintain workflow generality. The SkillEvolutionEngine
 * registry records the custom filePath, and ContextLoader resolves it via registry
 * fallback when the skill is not found in the standard skillsDir.
 *
 * Trigger: runs once during _initWorkflow() when no project-specific standards
 * skill exists yet (cold-start detection).
 *
 * Design principles:
 *   - ADR-37 IDE-First: no external model dependencies; uses the existing llmCall
 *   - Zero new dependencies: only Node.js built-ins (fs, path)
 *   - Non-fatal: all errors are caught and logged; never blocks workflow init
 *   - Idempotent: skips if standards skill already exists with real content
 *
 * @module workflow/core/skill-discovery
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Scanner Definitions ──────────────────────────────────────────────────────

/**
 * Each scanner targets a specific config file / artifact and extracts
 * structured convention signals. Scanners are pure functions with zero
 * side effects — they read files and return data.
 *
 * @typedef {object} ConventionSignal
 * @property {string} source   - Which file/artifact produced this signal
 * @property {string} category - 'coding-style' | 'naming' | 'structure' | 'toolchain' | 'testing' | 'git' | 'general'
 * @property {string} signal   - Human-readable convention description
 */

const SCANNERS = [

  // ── 1. AGENTS.md — project-level instructions ──────────────────────────────
  {
    id: 'agents-md',
    files: ['AGENTS.md', 'agents.md'],
    scan(content, _filePath) {
      const signals = [];
      // Extract lines containing strong directives (MUST, NEVER, ALWAYS, DO NOT)
      // Only capture lines that are list items or blockquotes (likely intentional rules)
      const rulePatterns = /^[\s>]*[-*]\s+.*\b(MUST(?:\s+NOT)?|NEVER|ALWAYS|DO NOT)\b.+/gm;
      let m;
      const seen = new Set();
      while ((m = rulePatterns.exec(content)) !== null) {
        const rule = m[0].replace(/^[\s>]*[-*]\s+/, '').trim();
        // Skip very short or very long matches (noise)
        if (rule.length < 15 || rule.length > 200) continue;
        // Deduplicate
        const key = rule.slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        signals.push({ source: 'AGENTS.md', category: 'general', signal: rule });
        if (signals.length >= 6) break; // Cap to avoid noise
      }
      // Extract project structure hints (code blocks with directory trees)
      if (/```[\s\S]*?├──[\s\S]*?```/.test(content)) {
        signals.push({ source: 'AGENTS.md', category: 'structure', signal: 'Project has documented directory structure in AGENTS.md' });
      }
      return signals;
    },
  },

  // ── 2. package.json — Node.js conventions ──────────────────────────────────
  {
    id: 'package-json',
    files: ['package.json'],
    scan(content, _filePath) {
      const signals = [];
      try {
        const pkg = JSON.parse(content);
        // Scripts reveal toolchain conventions
        if (pkg.scripts) {
          const scripts = Object.entries(pkg.scripts);
          for (const [name, cmd] of scripts.slice(0, 10)) {
            if (['test', 'lint', 'build', 'start', 'dev', 'format', 'typecheck'].includes(name)) {
              signals.push({ source: 'package.json', category: 'toolchain', signal: `npm script "${name}": ${cmd}` });
            }
          }
        }
        // Engine constraints
        if (pkg.engines) {
          for (const [engine, version] of Object.entries(pkg.engines)) {
            signals.push({ source: 'package.json', category: 'toolchain', signal: `Engine constraint: ${engine} ${version}` });
          }
        }
        // Type field
        if (pkg.type === 'module') {
          signals.push({ source: 'package.json', category: 'coding-style', signal: 'Project uses ES Modules (type: "module")' });
        }
      } catch { /* not valid JSON — skip */ }
      return signals;
    },
  },

  // ── 3. ESLint config — coding style ────────────────────────────────────────
  {
    id: 'eslint',
    files: ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs'],
    scan(content, filePath) {
      const signals = [];
      const ext = path.extname(filePath);
      signals.push({ source: path.basename(filePath), category: 'coding-style', signal: `ESLint is configured (${path.basename(filePath)})` });
      // Detect popular presets
      const presets = ['airbnb', 'standard', 'google', 'prettier', 'eslint:recommended', 'plugin:react', 'plugin:vue', 'plugin:@typescript-eslint'];
      for (const preset of presets) {
        if (content.includes(preset)) {
          signals.push({ source: path.basename(filePath), category: 'coding-style', signal: `ESLint extends: ${preset}` });
        }
      }
      return signals;
    },
  },

  // ── 4. Prettier config — formatting ────────────────────────────────────────
  {
    id: 'prettier',
    files: ['.prettierrc', '.prettierrc.js', '.prettierrc.json', 'prettier.config.js', 'prettier.config.mjs'],
    scan(content, filePath) {
      const signals = [];
      signals.push({ source: path.basename(filePath), category: 'coding-style', signal: 'Prettier is configured for code formatting' });
      // Try to extract key settings
      try {
        const cfg = JSON.parse(content);
        if (cfg.semi !== undefined) signals.push({ source: 'prettier', category: 'coding-style', signal: `Semicolons: ${cfg.semi ? 'required' : 'omitted'}` });
        if (cfg.singleQuote !== undefined) signals.push({ source: 'prettier', category: 'coding-style', signal: `Quotes: ${cfg.singleQuote ? 'single' : 'double'}` });
        if (cfg.tabWidth) signals.push({ source: 'prettier', category: 'coding-style', signal: `Tab width: ${cfg.tabWidth}` });
        if (cfg.trailingComma) signals.push({ source: 'prettier', category: 'coding-style', signal: `Trailing commas: ${cfg.trailingComma}` });
      } catch { /* not JSON — might be JS/YAML, just note it exists */ }
      return signals;
    },
  },

  // ── 5. TypeScript config — type system ─────────────────────────────────────
  {
    id: 'tsconfig',
    files: ['tsconfig.json', 'tsconfig.base.json'],
    scan(content, _filePath) {
      const signals = [];
      try {
        // tsconfig may have comments — strip them for JSON.parse
        const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const cfg = JSON.parse(stripped);
        const co = cfg.compilerOptions || {};
        if (co.strict) signals.push({ source: 'tsconfig.json', category: 'coding-style', signal: 'TypeScript strict mode enabled' });
        if (co.target) signals.push({ source: 'tsconfig.json', category: 'toolchain', signal: `TypeScript target: ${co.target}` });
        if (co.module) signals.push({ source: 'tsconfig.json', category: 'toolchain', signal: `TypeScript module system: ${co.module}` });
        if (co.paths) signals.push({ source: 'tsconfig.json', category: 'structure', signal: `TypeScript path aliases configured (${Object.keys(co.paths).length} aliases)` });
      } catch { /* parse error — skip */ }
      return signals;
    },
  },

  // ── 6. Docker / Containerization ───────────────────────────────────────────
  {
    id: 'docker',
    files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'],
    scan(content, filePath) {
      const signals = [];
      const name = path.basename(filePath);
      signals.push({ source: name, category: 'toolchain', signal: `Docker is used (${name} present)` });
      // Extract base image from Dockerfile
      if (name === 'Dockerfile') {
        const fromMatch = content.match(/^FROM\s+(\S+)/mi);
        if (fromMatch) {
          signals.push({ source: 'Dockerfile', category: 'toolchain', signal: `Docker base image: ${fromMatch[1]}` });
        }
      }
      return signals;
    },
  },

  // ── 7. Makefile / build system ─────────────────────────────────────────────
  {
    id: 'makefile',
    files: ['Makefile', 'makefile'],
    scan(content, _filePath) {
      const signals = [];
      signals.push({ source: 'Makefile', category: 'toolchain', signal: 'Make is used as build system' });
      // Extract target names (lines matching "target:")
      const targets = [];
      const targetRe = /^([a-zA-Z_][\w-]*)\s*:/gm;
      let m;
      while ((m = targetRe.exec(content)) !== null && targets.length < 8) {
        if (!m[1].startsWith('.')) targets.push(m[1]);
      }
      if (targets.length > 0) {
        signals.push({ source: 'Makefile', category: 'toolchain', signal: `Make targets: ${targets.join(', ')}` });
      }
      return signals;
    },
  },

  // ── 8. Go module ───────────────────────────────────────────────────────────
  {
    id: 'go-mod',
    files: ['go.mod'],
    scan(content, _filePath) {
      const signals = [];
      const moduleMatch = content.match(/^module\s+(\S+)/m);
      if (moduleMatch) {
        signals.push({ source: 'go.mod', category: 'structure', signal: `Go module: ${moduleMatch[1]}` });
      }
      const goMatch = content.match(/^go\s+(\S+)/m);
      if (goMatch) {
        signals.push({ source: 'go.mod', category: 'toolchain', signal: `Go version: ${goMatch[1]}` });
      }
      return signals;
    },
  },

  // ── 9. Rust Cargo ──────────────────────────────────────────────────────────
  {
    id: 'cargo',
    files: ['Cargo.toml'],
    scan(content, _filePath) {
      const signals = [];
      const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
      if (nameMatch) {
        signals.push({ source: 'Cargo.toml', category: 'structure', signal: `Rust crate: ${nameMatch[1]}` });
      }
      const editionMatch = content.match(/^edition\s*=\s*"([^"]+)"/m);
      if (editionMatch) {
        signals.push({ source: 'Cargo.toml', category: 'toolchain', signal: `Rust edition: ${editionMatch[1]}` });
      }
      return signals;
    },
  },

  // ── 10. Git conventions ────────────────────────────────────────────────────
  {
    id: 'git-conventions',
    files: ['.commitlintrc', '.commitlintrc.json', '.commitlintrc.js', 'commitlint.config.js', '.husky/commit-msg'],
    scan(content, filePath) {
      const signals = [];
      signals.push({ source: path.basename(filePath), category: 'git', signal: 'Commit message linting is configured (conventional commits likely enforced)' });
      if (content.includes('conventional')) {
        signals.push({ source: path.basename(filePath), category: 'git', signal: 'Conventional Commits standard is enforced' });
      }
      return signals;
    },
  },

  // ── 11. CI/CD config ───────────────────────────────────────────────────────
  {
    id: 'ci',
    files: ['.github/workflows/ci.yml', '.github/workflows/ci.yaml', '.gitlab-ci.yml', 'Jenkinsfile', '.circleci/config.yml'],
    scan(content, filePath) {
      const signals = [];
      const name = path.basename(filePath);
      if (filePath.includes('.github')) {
        signals.push({ source: name, category: 'toolchain', signal: 'GitHub Actions CI/CD is configured' });
      } else if (filePath.includes('.gitlab')) {
        signals.push({ source: name, category: 'toolchain', signal: 'GitLab CI/CD is configured' });
      } else if (name === 'Jenkinsfile') {
        signals.push({ source: name, category: 'toolchain', signal: 'Jenkins CI/CD is configured' });
      }
      return signals;
    },
  },

  // ── 12. Testing config ─────────────────────────────────────────────────────
  {
    id: 'testing',
    files: ['jest.config.js', 'jest.config.ts', 'vitest.config.ts', 'vitest.config.js', 'pytest.ini', 'pyproject.toml', '.mocharc.yml', '.mocharc.json'],
    scan(content, filePath) {
      const signals = [];
      const name = path.basename(filePath);
      if (name.startsWith('jest')) {
        signals.push({ source: name, category: 'testing', signal: 'Jest is the test framework' });
      } else if (name.startsWith('vitest')) {
        signals.push({ source: name, category: 'testing', signal: 'Vitest is the test framework' });
      } else if (name.startsWith('.mocharc')) {
        signals.push({ source: name, category: 'testing', signal: 'Mocha is the test framework' });
      } else if (name === 'pytest.ini' || (name === 'pyproject.toml' && content.includes('[tool.pytest'))) {
        signals.push({ source: name, category: 'testing', signal: 'Pytest is the test framework' });
      }
      return signals;
    },
  },
];

// ─── Core Discovery Logic ─────────────────────────────────────────────────────

/**
 * Runs all rule-based scanners against the project root.
 * Zero LLM calls — pure file I/O + regex.
 *
 * @param {string} projectRoot - Absolute path to project root
 * @returns {ConventionSignal[]} Array of discovered convention signals
 */
function scanProjectConventions(projectRoot) {
  const allSignals = [];

  for (const scanner of SCANNERS) {
    for (const relFile of scanner.files) {
      const fullPath = path.join(projectRoot, relFile);
      try {
        if (!fs.existsSync(fullPath)) continue;
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (!content.trim()) continue;
        const signals = scanner.scan(content, fullPath);
        allSignals.push(...signals);
      } catch {
        // Non-fatal: skip unreadable files
      }
    }
  }

  // ── Bonus: scan top-level directory structure ──────────────────────────────
  try {
    const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'dist', 'build', 'output', '__pycache__', 'target', 'vendor'].includes(e.name))
      .map(e => e.name)
      .slice(0, 15);
    if (dirs.length > 0) {
      allSignals.push({
        source: 'directory-scan',
        category: 'structure',
        signal: `Top-level directories: ${dirs.join(', ')}`,
      });
    }
  } catch { /* non-fatal */ }

  // ── Deduplicate signals by content ─────────────────────────────────────────
  const seen = new Set();
  return allSignals.filter(s => {
    const key = `${s.category}:${s.signal.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Formats discovered signals into a structured summary for LLM refinement.
 *
 * @param {ConventionSignal[]} signals
 * @returns {string} Formatted summary text
 */
function formatSignalsForLLM(signals) {
  if (signals.length === 0) return '';

  // Group by category
  const grouped = {};
  for (const s of signals) {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push(s);
  }

  const lines = ['# Discovered Project Conventions', ''];
  for (const [category, items] of Object.entries(grouped)) {
    lines.push(`## ${category}`);
    for (const item of items) {
      lines.push(`- [${item.source}] ${item.signal}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Builds the LLM prompt for refining raw signals into a standards skill.
 *
 * @param {string} signalsSummary - Output of formatSignalsForLLM()
 * @returns {string} LLM prompt
 */
function buildRefinementPrompt(signalsSummary) {
  return `You are a senior software engineer analyzing a project's conventions.

Below are raw convention signals extracted from the project's configuration files.
Your task: synthesize these into a concise, actionable "Project Standards" document.

${signalsSummary}

Output a Markdown document with EXACTLY these sections (keep each section concise, 3-8 bullet points max):

## Coding Standards
<!-- Language-specific coding rules enforced in this project -->

## Naming Conventions
<!-- File, variable, function, class naming patterns -->

## Directory Structure
<!-- Where different types of files live -->

## Toolchain
<!-- Build tools, linters, formatters, test frameworks, CI/CD -->

## Commit Conventions
<!-- Git commit message format, branch naming if detectable -->

Rules:
- Only include conventions you can CONFIDENTLY infer from the signals above
- Do NOT invent conventions that aren't supported by the signals
- Use imperative voice ("Use X", "Always Y", "Never Z")
- Keep total output under 1500 characters
- If a section has no signals, write "_No conventions detected._"`;
}

/**
 * Main entry point: discovers project conventions and generates a standards skill.
 *
 * @param {object} options
 * @param {string}   options.projectRoot     - Absolute path to project root
 * @param {object}   options.skillEvolution  - SkillEvolutionEngine instance
 * @param {Function} [options.llmCall]       - LLM call function (optional; if absent, generates rule-only skill)
 * @param {boolean}  [options.force=false]   - Force re-discovery even if skill exists
 * @returns {Promise<{ discovered: boolean, signalCount: number, skillName: string|null, usedLLM: boolean }>}
 */
async function discoverProjectSkills({ projectRoot, skillEvolution, llmCall = null, force = false }) {
  const SKILL_NAME = 'project-standards';
  const result = { discovered: false, signalCount: 0, skillName: null, usedLLM: false };

  // ── Resolve project-local skill directory ──────────────────────────────────
  // Project-specific skills live in <projectRoot>/.workflow/skills/ to keep
  // the workflow/ directory generic and project-agnostic.
  const projectSkillsDir = path.join(projectRoot, '.workflow', 'skills');
  const projectSkillPath = path.join(projectSkillsDir, `${SKILL_NAME}.md`);

  // ── Guard: skip if skill already exists with real content ──────────────────
  if (!force) {
    // Check both registry and project-local file
    const existingPath = skillEvolution.registry.has(SKILL_NAME)
      ? skillEvolution.registry.get(SKILL_NAME).filePath
      : (fs.existsSync(projectSkillPath) ? projectSkillPath : null);

    if (existingPath && fs.existsSync(existingPath)) {
      const content = fs.readFileSync(existingPath, 'utf-8');
      // Check if it has real content (not just placeholder)
      const realLines = content.split('\n')
        .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('---') && !l.startsWith('|') && !l.startsWith('<!--'))
        .filter(l => !l.includes('_No ') && !l.includes('defined yet'));
      if (realLines.length >= 5) {
        console.log(`[SkillDiscovery] ⏭️  Skill "${SKILL_NAME}" already exists with content (${realLines.length} lines). Skipping.`);
        return result;
      }
    }
  }

  // ── Step 1: Rule-based scanning (zero LLM calls) ──────────────────────────
  const signals = scanProjectConventions(projectRoot);
  result.signalCount = signals.length;

  if (signals.length === 0) {
    console.log(`[SkillDiscovery] ℹ️  No convention signals found in project. Skipping skill generation.`);
    return result;
  }

  console.log(`[SkillDiscovery] 🔍 Scanned project: ${signals.length} convention signal(s) from ${new Set(signals.map(s => s.source)).size} source(s).`);

  // ── Step 2: Generate skill content ─────────────────────────────────────────
  let skillContent;
  const signalsSummary = formatSignalsForLLM(signals);

  if (llmCall && typeof llmCall === 'function') {
    // LLM refinement path: 1 call, ~2000 tokens
    try {
      const prompt = buildRefinementPrompt(signalsSummary);
      const refined = await llmCall(prompt);
      if (refined && refined.trim().length > 50) {
        skillContent = refined.trim();
        result.usedLLM = true;
        console.log(`[SkillDiscovery] 🤖 LLM refined ${signals.length} signals into standards skill (${skillContent.length} chars).`);
      }
    } catch (err) {
      console.warn(`[SkillDiscovery] ⚠️  LLM refinement failed (falling back to rule-only): ${err.message}`);
    }
  }

  // Fallback: use raw signals as skill content (no LLM needed)
  if (!skillContent) {
    skillContent = _buildRuleOnlyContent(signals);
    console.log(`[SkillDiscovery] 📝 Generated rule-only standards skill (${skillContent.length} chars, no LLM used).`);
  }

  // ── Step 3: Write skill to project directory and register ──────────────────
  try {
    // Write skill file to <projectRoot>/.workflow/skills/ (NOT workflow/skills/)
    _writeDiscoveredSkill(projectSkillPath, skillContent, signals.length, result.usedLLM);

    // Register in SkillEvolutionEngine with custom filePath pointing to project dir
    skillEvolution.registerSkill({
      name: SKILL_NAME,
      description: 'Auto-discovered project conventions, coding standards, and toolchain configuration',
      domains: ['standards', 'conventions', 'project'],
      type: 'standards',
      loadLevel: 'project',
      maxTokens: 1200,
      triggers: {
        keywords: ['standard', 'convention', 'style', 'lint', 'format', 'naming', 'structure'],
        roles: ['analyst', 'architect', 'developer', 'reviewer'],
      },
      filePath: projectSkillPath,  // Custom path: project dir, not workflow/skills/
    });

    result.discovered = true;
    result.skillName = SKILL_NAME;
    console.log(`[SkillDiscovery] ✅ Project standards skill generated: ${projectSkillPath}`);
  } catch (err) {
    console.warn(`[SkillDiscovery] ⚠️  Skill registration failed (non-fatal): ${err.message}`);
  }

  return result;
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Builds skill content from raw signals without LLM refinement.
 * Groups signals by category and formats as Markdown sections.
 *
 * @param {ConventionSignal[]} signals
 * @returns {string}
 */
function _buildRuleOnlyContent(signals) {
  const grouped = {};
  for (const s of signals) {
    if (!grouped[s.category]) grouped[s.category] = [];
    grouped[s.category].push(s);
  }

  const categoryToSection = {
    'coding-style': 'Coding Standards',
    'naming': 'Naming Conventions',
    'structure': 'Directory Structure',
    'toolchain': 'Toolchain',
    'testing': 'Toolchain',
    'git': 'Commit Conventions',
    'general': 'Coding Standards',
  };

  const sections = {};
  for (const [category, items] of Object.entries(grouped)) {
    const sectionName = categoryToSection[category] || 'Coding Standards';
    if (!sections[sectionName]) sections[sectionName] = [];
    for (const item of items) {
      sections[sectionName].push(`- ${item.signal} _(from ${item.source})_`);
    }
  }

  const lines = [];
  const sectionOrder = ['Coding Standards', 'Naming Conventions', 'Directory Structure', 'Toolchain', 'Commit Conventions'];
  for (const name of sectionOrder) {
    lines.push(`## ${name}`);
    if (sections[name] && sections[name].length > 0) {
      lines.push(...sections[name]);
    } else {
      lines.push('_No conventions detected._');
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Writes the discovered skill content to disk, preserving YAML frontmatter.
 *
 * @param {string} filePath   - Skill file path
 * @param {string} content    - Skill body content (Markdown)
 * @param {number} signalCount - Number of signals discovered
 * @param {boolean} usedLLM   - Whether LLM refinement was used
 */
function _writeDiscoveredSkill(filePath, content, signalCount, usedLLM) {
  const frontmatter = [
    `---`,
    `name: project-standards`,
    `version: 1.0.0`,
    `type: standards`,
    `domains: [standards, conventions, project]`,
    `dependencies: []`,
    `load_level: project`,
    `max_tokens: 1200`,
    `triggers:`,
    `  keywords: [standard, convention, style, lint, format, naming, structure]`,
    `  roles: [analyst, architect, developer, reviewer]`,
    `description: "Auto-discovered project conventions, coding standards, and toolchain configuration"`,
    `auto_discovered: true`,
    `discovery_signals: ${signalCount}`,
    `discovery_method: ${usedLLM ? 'rule-scan+llm' : 'rule-scan-only'}`,
    `---`,
  ].join('\n');

  const fullContent = [
    frontmatter,
    ``,
    `# Skill: project-standards`,
    ``,
    `> **Version**: 1.0.0`,
    `> **Description**: Auto-discovered project conventions, coding standards, and toolchain configuration`,
    `> **Domains**: standards, conventions, project`,
    `> **Auto-discovered**: ✅ (${signalCount} signals, method: ${usedLLM ? 'rule-scan + LLM refinement' : 'rule-scan only'})`,
    ``,
    `---`,
    ``,
    content,
    ``,
    `## Evolution History`,
    ``,
    `| Version | Date | Change |`,
    `|---------|------|--------|`,
    `| v1.0.0 | ${new Date().toISOString().slice(0, 10)} | Auto-discovered from project config files |`,
  ].join('\n');

  // Atomic write
  const tmpPath = filePath + '.tmp';
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(tmpPath, fullContent, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  discoverProjectSkills,
  scanProjectConventions,
  formatSignalsForLLM,
  buildRefinementPrompt,
  // Exposed for testing
  _buildRuleOnlyContent,
  _writeDiscoveredSkill,
  SCANNERS,
};
