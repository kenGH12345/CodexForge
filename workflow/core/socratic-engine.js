/**
 * Socratic Interaction Engine
 *
 * Implements Requirement 7: AI Socratic-style questioning paradigm.
 *
 * Instead of asking users to proactively review and recall information,
 * the system presents structured multiple-choice questions at decision points.
 *
 * Benefits:
 *  - Reduces cognitive load (user picks from options, not free-form recall)
 *  - Externalises implicit knowledge (answers written to context files)
 *  - Enables automatic continuation after human input
 *  - Lowers hallucination risk (decisions are explicit, not assumed)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { PATHS } = require('../core/constants');

// ─── Question Builder ─────────────────────────────────────────────────────────

/**
 * Builds a structured multiple-choice question.
 *
 * @param {string}   id       - Unique question ID (used as key in context file)
 * @param {string}   question - The question text
 * @param {string[]} options  - Array of option strings
 * @param {string}   [context] - Additional context shown before the question
 * @returns {SocraticQuestion}
 */
function buildQuestion(id, question, options, context = '') {
  if (options.length < 2) throw new Error(`[Socratic] Question "${id}" must have at least 2 options.`);
  return { id, question, options, context, askedAt: null, answeredAt: null, answer: null };
}

// ─── Pre-defined Decision Questions ──────────────────────────────────────────

const DECISION_QUESTIONS = {
  ARCHITECTURE_APPROVAL: buildQuestion(
    'architecture_approval',
    'Does the generated architecture meet your expectations?',
    [
      'Yes, approve and proceed to code generation',
      'No, the architecture needs revision – abort and restart',
      'Partially – proceed but note concerns in the context',
    ],
    'The Architecture Design Agent has produced architecture.md. Please review it before code generation begins.'
  ),

  TECH_STACK_PREFERENCE: buildQuestion(
    'tech_stack_preference',
    'Which technology stack do you prefer for this project?',
    [
      'Follow the architecture document recommendation',
      'Use a minimal/lightweight stack',
      'Use an enterprise-grade stack with full observability',
    ]
  ),

  TEST_DEFECTS_ACTION: buildQuestion(
    'test_defects_action',
    'The test report found defects. How should the workflow proceed?',
    [
      'Fix all Critical and High defects before delivery',
      'Fix Critical defects only, log others as known issues',
      'Deliver as-is with the full defect report attached',
    ],
    'The Quality Testing Agent has found defects in the code. Please decide how to proceed.'
  ),

  SCOPE_CLARIFICATION: buildQuestion(
    'scope_clarification',
    'The requirement has ambiguous scope. Which interpretation is correct?',
    [
      'Minimal scope – implement only the core feature',
      'Full scope – implement all mentioned features',
      'Let the Analyst Agent decide based on best practices',
    ]
  ),
};

// ─── Socratic Engine ──────────────────────────────────────────────────────────

class SocraticEngine {
  /**
   * @param {string} contextFilePath - Path to the context file where answers are persisted
   */
  constructor(contextFilePath = null) {
    this.contextFilePath = contextFilePath || path.join(PATHS.OUTPUT_DIR, 'decisions.json');
    this._decisions = this._loadDecisions();
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Asks a structured multiple-choice question and waits for the user's answer.
   * The answer is persisted to the context file (implicit knowledge → explicit).
   *
   * @param {SocraticQuestion} question
   * @returns {Promise<{ optionIndex: number, optionText: string }>}
   */
  async ask(question) {
    // Check if already answered (idempotent – supports resume)
    const cached = this._decisions[question.id];
    if (cached) {
      console.log(`[Socratic] Question "${question.id}" already answered: "${cached.optionText}". Skipping.`);
      return cached;
    }

    question.askedAt = new Date().toISOString();
    const answer = await this._promptUser(question);

    question.answeredAt = new Date().toISOString();
    question.answer = answer;

    // Persist answer (implicit knowledge → explicit)
    this._decisions[question.id] = answer;
    this._saveDecisions();

    console.log(`[Socratic] Answer recorded: "${question.id}" → "${answer.optionText}"`);
    return answer;
  }

  /**
   * Asks a question by its pre-defined ID from DECISION_QUESTIONS.
   *
   * @param {string} questionId - Key from DECISION_QUESTIONS
   * @returns {Promise<{ optionIndex: number, optionText: string }>}
   */
  async askById(questionId) {
    const question = DECISION_QUESTIONS[questionId];
    if (!question) {
      throw new Error(`[Socratic] Unknown question ID: "${questionId}". Available: ${Object.keys(DECISION_QUESTIONS).join(', ')}`);
    }
    return this.ask(question);
  }

  /**
   * Non-blocking async decision point. (P2-C fix)
   *
   * Problem it solves:
   *   The blocking ask() call breaks Agent autonomy. In non-interactive environments
   *   (CI, batch runs, automated pipelines) the 30s timeout causes unnecessary delays.
   *   Even in interactive mode, forcing the user to respond before the Agent can
   *   continue is a poor UX – the Agent should proceed with a sensible default and
   *   let the user override asynchronously.
   *
   * How it works:
   *   1. Immediately returns `defaultIndex` (the Agent proceeds without waiting).
   *   2. Prints a non-blocking notification to stdout so the user knows a decision
   *      was made on their behalf.
   *   3. If an `onOverride` callback is provided, spawns a background readline prompt.
   *      If the user responds before `overrideWindowMs`, the callback is invoked with
   *      the override decision (the caller can use this to adjust behaviour mid-flight).
   *   4. The decision is persisted to decisions.json so it is visible in the audit trail.
   *
   * @param {SocraticQuestion} question
   * @param {number}   [defaultIndex=0]       - Option index to use immediately
   * @param {object}   [options]
   * @param {number}   [options.overrideWindowMs=10000] - How long to wait for override (ms)
   * @param {Function} [options.onOverride]   - Called with override answer if user responds
   * @returns {{ optionIndex: number, optionText: string }} Immediate default answer
   */
  askAsync(question, defaultIndex = 0, { overrideWindowMs = 10_000, onOverride = null } = {}) {
    // Check if already answered (idempotent – supports resume)
    const cached = this._decisions[question.id];
    if (cached) {
      console.log(`[Socratic] ⚡ Non-blocking: "${question.id}" already answered: "${cached.optionText}". Using cached.`);
      return cached;
    }

    const defaultAnswer = {
      optionIndex: defaultIndex,
      optionText:  question.options[defaultIndex],
      timestamp:   new Date().toISOString(),
      source:      'auto-default',
    };

    // Persist the default decision immediately
    this._decisions[question.id] = defaultAnswer;
    this._saveDecisions();

    console.log([
      ``,
      `╔══════════════════════════════════════════════════════════╗`,
      `║  ⚡ AUTO-DECISION (Non-blocking Socratic Mode)           ║`,
      `╚══════════════════════════════════════════════════════════╝`,
      ``,
      `❓ ${question.question}`,
      ``,
      `  ✅ Auto-selected: [${defaultIndex + 1}] ${question.options[defaultIndex]}`,
      ``,
      `  You have ${overrideWindowMs / 1000}s to override. Enter a number to change:`,
      ...question.options.map((opt, i) => `    [${i + 1}] ${opt}`),
      `  (Press Enter or wait to accept the auto-selection)`,
      ``,
    ].join('\n'));

    // Spawn background override window (fire-and-forget)
    if (typeof onOverride === 'function') {
      this._spawnOverrideWindow(question, defaultAnswer, overrideWindowMs, onOverride);
    }

    return defaultAnswer;
  }

  /**
   * Spawns a background readline prompt for the override window.
   *
   * P2-NEW-4 fix: guard against CI / non-interactive environments where
   * process.stdin is closed, piped from /dev/null, or not a TTY.
   * In those cases readline.createInterface() may hang indefinitely because
   * rl.question() never fires its callback (stdin EOF is never signalled).
   * We detect non-interactive stdin early and skip the readline entirely,
   * letting the auto-default stand without any blocking I/O.
   *
   * Detection heuristics (any one is sufficient to skip readline):
   *   1. process.stdin.isTTY is falsy (piped, redirected, or /dev/null)
   *   2. CI environment variable is set (GitHub Actions, CircleCI, Jenkins, etc.)
   *   3. process.env.TERM === 'dumb' (non-interactive terminal)
   *
   * @private
   */
  _spawnOverrideWindow(question, defaultAnswer, overrideWindowMs, onOverride) {
    // P2-NEW-4: detect non-interactive / CI environment and skip readline.
    const isCI = !!(
      process.env.CI ||
      process.env.CONTINUOUS_INTEGRATION ||
      process.env.GITHUB_ACTIONS ||
      process.env.JENKINS_URL ||
      process.env.CIRCLECI ||
      process.env.TRAVIS
    );
    const isNonInteractive = !process.stdin.isTTY || isCI || process.env.TERM === 'dumb';

    if (isNonInteractive) {
      // Non-interactive: auto-confirm the default immediately, no readline needed.
      console.log(`[Socratic] ℹ️  Non-interactive environment detected (CI=${isCI}, isTTY=${!!process.stdin.isTTY}). Auto-confirming default: "${defaultAnswer.optionText}"`);
      // Fire onOverride with the default so callers that rely on the callback still work.
      try { onOverride(defaultAnswer); } catch (_) {}
      return;
    }

    let settled = false;
    let timer = null;

    const settle = (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { rl.close(); } catch (_) {}
      if (answer.optionIndex !== defaultAnswer.optionIndex) {
        // User chose a different option – persist override and notify caller
        this._decisions[question.id] = answer;
        this._saveDecisions();
        console.log(`[Socratic] 🔄 Override accepted: "${question.id}" → "${answer.optionText}"`);
        try { onOverride(answer); } catch (_) {}
      } else {
        console.log(`[Socratic] ✅ Override window closed. Auto-selection confirmed: "${defaultAnswer.optionText}"`);
      }
    };

    // Wrap readline creation in try/catch: even after the isTTY check, some
    // environments (e.g. Docker with stdin closed) can throw on createInterface.
    let rl;
    try {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    } catch (err) {
      console.warn(`[Socratic] ⚠️  Could not create readline interface: ${err.message}. Auto-confirming default.`);
      try { onOverride(defaultAnswer); } catch (_) {}
      return;
    }

    const validChoices = question.options.map((_, i) => String(i + 1));

    timer = setTimeout(() => settle(defaultAnswer), overrideWindowMs);

    const prompt = () => {
      if (settled) return;
      rl.question(`Override (${validChoices.join('/')}): `, (answer) => {
        if (settled) return;
        const trimmed = answer.trim();
        if (trimmed === '') { settle(defaultAnswer); return; }
        if (!validChoices.includes(trimmed)) { prompt(); return; }
        settle({
          optionIndex: parseInt(trimmed, 10) - 1,
          optionText:  question.options[parseInt(trimmed, 10) - 1],
          timestamp:   new Date().toISOString(),
          source:      'user-override',
        });
      });
    };
    prompt();
  }

  /**
   * Returns all recorded decisions (the externalised knowledge base).
   */
  getDecisions() {
    return { ...this._decisions };
  }

  /**
   * Clears all recorded decisions (for fresh runs).
   */
  clearDecisions() {
    this._decisions = {};
    this._saveDecisions();
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  async _promptUser(question) {
    // P2-NEW-4: detect non-interactive / CI environment and skip readline.
    // Same heuristics as _spawnOverrideWindow.
    const isCI = !!(
      process.env.CI || process.env.CONTINUOUS_INTEGRATION ||
      process.env.GITHUB_ACTIONS || process.env.JENKINS_URL ||
      process.env.CIRCLECI || process.env.TRAVIS
    );
    const isNonInteractive = !process.stdin.isTTY || isCI || process.env.TERM === 'dumb';
    if (isNonInteractive) {
      console.log(`[Socratic] ℹ️  Non-interactive environment – auto-selecting option [1]: "${question.options[0]}"`);
      return { optionIndex: 0, optionText: question.options[0], timestamp: new Date().toISOString(), source: 'ci-auto' };
    }

    const lines = [
      ``,
      `╔══════════════════════════════════════════════════════════╗`,
      `║  🤔 DECISION REQUIRED (Socratic Mode)                    ║`,
      `╚══════════════════════════════════════════════════════════╝`,
      ``,
    ];

    if (question.context) {
      lines.push(`Context: ${question.context}`);
      lines.push(``);
    }

    lines.push(`❓ ${question.question}`);
    lines.push(``);
    question.options.forEach((opt, i) => {
      lines.push(`  [${i + 1}] ${opt}`);
    });
    lines.push(``);

    console.log(lines.join('\n'));

    const TIMEOUT_MS = 30000;

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;

      const settle = (optionIndex) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { rl.close(); } catch (_) {}
        resolve({
          optionIndex,
          optionText: question.options[optionIndex],
          timestamp: new Date().toISOString(),
        });
      };

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const validChoices = question.options.map((_, i) => String(i + 1));

      // Auto-select option 0 on timeout
      timer = setTimeout(() => {
        console.log(`\n[Socratic] ⏱️  No response in ${TIMEOUT_MS / 1000}s. Auto-selecting option [1]: "${question.options[0]}"`);
        settle(0);
      }, TIMEOUT_MS);

      const prompt = () => {
        if (settled) return;
        rl.question(`Your choice (${validChoices.join('/')}): `, (answer) => {
          if (settled) return;
          const trimmed = answer.trim();
          if (!validChoices.includes(trimmed)) {
            console.log(`Invalid choice. Please enter ${validChoices.join(' or ')}.`);
            prompt();
            return;
          }
          settle(parseInt(trimmed, 10) - 1);
        });
      };
      prompt();
    });
  }

  _loadDecisions() {
    if (fs.existsSync(this.contextFilePath)) {
      try {
        return JSON.parse(fs.readFileSync(this.contextFilePath, 'utf-8'));
      } catch (_) {
        return {};
      }
    }
    return {};
  }

  _saveDecisions() {
    const dir = path.dirname(this.contextFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // N66 fix: atomic write – write to a .tmp file first, then rename over the target.
    // Prevents a process crash mid-write from corrupting decisions.json.
    const tmpPath = this.contextFilePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(this._decisions, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.contextFilePath);
  }
}

module.exports = { SocraticEngine, DECISION_QUESTIONS, buildQuestion };
