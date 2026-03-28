/**
 * Orchestrator Task Validation Utilities
 *
 * Pure functions for task decomposition validation, coherence checks,
 * and requirement coverage analysis. Extracted from orchestrator-task.js.
 *
 * These functions have no dependency on Orchestrator instance state,
 * making them easy to test and reuse.
 *
 * @module workflow/core/orchestrator-task-validation
 */

'use strict';

// ─── Stopwords for Keyword Extraction ─────────────────────────────────────────

const DECOMP_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall',
  'can', 'need', 'must', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'we', 'you',
  'they', 'he', 'she', 'my', 'our', 'your', 'their', 'all', 'each', 'every', 'both',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'not', 'only', 'same', 'so',
  'than', 'too', 'very', 'just', 'about', 'above', 'after', 'again', 'also', 'any',
  'because', 'before', 'below', 'between', 'during', 'further', 'here', 'how', 'if',
  'into', 'once', 'out', 'over', 'own', 'then', 'there', 'through', 'under', 'until',
  'up', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'what', 'as', 'new',
  'use', 'using', 'used', 'make', 'like', 'get', 'set',
  'implement', 'create', 'build', 'add', 'update', 'write', 'code', 'develop',
  'feature', 'function', 'method', 'class', 'file', 'module', 'system', 'project',
  'please', 'want', 'based', 'following',
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '他', '她', '它', '我们', '你们', '他们', '这个', '那个',
  '可以', '需要', '进行', '实现', '使用', '通过', '以及', '并且', '或者',
]);

// ─── Keyword Extraction ───────────────────────────────────────────────────────

/**
 * Extracts significant (non-stopword) keywords from a text string.
 * Supports both English and Chinese text. Returns lowercased unique words.
 *
 * @param {string} text - Input text
 * @returns {string[]} Array of significant words
 */
function extractSignificantWords(text) {
  if (!text || typeof text !== 'string') return [];
  const words = new Set();

  // English words (2+ chars, alphanumeric with underscores/hyphens)
  const englishWords = text.toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) || [];
  for (const w of englishWords) {
    if (!DECOMP_STOPWORDS.has(w) && w.length > 2) {
      words.add(w);
    }
  }

  // Chinese segments (2+ consecutive Chinese characters)
  const chineseChars = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const segment of chineseChars) {
    if (!DECOMP_STOPWORDS.has(segment) && segment.length >= 2) {
      words.add(segment);
    }
  }

  return Array.from(words);
}

// ─── Task Decomposition Validation ─────────────────────────────────────────────

/**
 * Validates the quality of LLM-generated task decomposition.
 *
 * Checks:
 * 1. Requirement keyword coverage
 * 2. Dependency graph validity (DAG check, no cycles)
 * 3. Task granularity balance
 * 4. Parallelism ratio (anti-serial-collapse guard)
 *
 * @param {Array} taskDefs - Array of task definitions
 * @param {string} rawRequirement - Original requirement text
 * @returns {Object} { issues: string[], warnings: string[], metrics: object }
 */
function validateDecomposition(taskDefs, rawRequirement) {
  const issues = [];
  const warnings = [];
  const metrics = {};

  if (!taskDefs || taskDefs.length === 0) {
    issues.push('No task definitions provided');
    return { issues, warnings, metrics };
  }

  // Check 1: Requirement Keyword Coverage
  const reqWords = extractSignificantWords(rawRequirement);
  const taskTitleWords = new Set();
  for (const t of taskDefs) {
    for (const w of extractSignificantWords(t.title)) {
      taskTitleWords.add(w);
    }
  }
  const coveredWords = reqWords.filter(w => taskTitleWords.has(w));
  const coverageRate = reqWords.length > 0
    ? Math.round((coveredWords.length / reqWords.length) * 100)
    : 100;
  metrics.keywordCoverage = coverageRate;

  if (coverageRate < 30) {
    issues.push(`Requirement keyword coverage too low (${coverageRate}%): tasks may not address the core requirement. ` +
      `Missing concepts: [${reqWords.filter(w => !taskTitleWords.has(w)).slice(0, 5).join(', ')}]`);
  } else if (coverageRate < 60) {
    warnings.push(`Requirement keyword coverage is moderate (${coverageRate}%). ` +
      `Potentially missing: [${reqWords.filter(w => !taskTitleWords.has(w)).slice(0, 5).join(', ')}]`);
  }

  // Check 2: Dependency Graph Validity (DAG check)
  const idSet = new Set(taskDefs.map(t => t.id));
  const inDegree = {};
  const adjacency = {};
  for (const t of taskDefs) {
    inDegree[t.id] = 0;
    adjacency[t.id] = [];
  }
  let invalidDeps = 0;
  for (const t of taskDefs) {
    for (const dep of (t.deps || [])) {
      if (!idSet.has(dep)) {
        invalidDeps++;
        continue;
      }
      adjacency[dep].push(t.id);
      inDegree[t.id]++;
    }
  }
  if (invalidDeps > 0) {
    warnings.push(`${invalidDeps} dependency reference(s) point to non-existent task IDs (will be ignored).`);
  }

  // Topological sort to detect cycles
  const queue = Object.keys(inDegree).filter(id => inDegree[id] === 0);
  let sorted = 0;
  const visited = new Set();
  while (queue.length > 0) {
    const node = queue.shift();
    visited.add(node);
    sorted++;
    for (const next of (adjacency[node] || [])) {
      inDegree[next]--;
      if (inDegree[next] === 0) queue.push(next);
    }
  }

  metrics.taskCount = taskDefs.length;
  metrics.hasCycle = sorted < taskDefs.length;

  if (sorted < taskDefs.length) {
    const cycleNodes = taskDefs.filter(t => !visited.has(t.id)).map(t => t.id);
    issues.push(`Dependency cycle detected among tasks: [${cycleNodes.join(', ')}]. Parallel execution would deadlock.`);
  }

  // Check for disconnected subgraphs
  const hasOutgoing = new Set();
  const hasIncoming = new Set();
  for (const t of taskDefs) {
    if ((t.deps || []).length > 0) {
      hasIncoming.add(t.id);
      t.deps.forEach(d => hasOutgoing.add(d));
    }
  }
  const isolated = taskDefs.filter(t => !hasOutgoing.has(t.id) && !hasIncoming.has(t.id));
  metrics.isolatedTasks = isolated.length;

  if (isolated.length > 1 && isolated.length === taskDefs.length) {
    warnings.push(`All ${isolated.length} tasks are completely independent (no dependencies). ` +
      `This may indicate the requirement was split into unrelated work items rather than a coherent plan.`);
  }

  // Check 3: Task Granularity Balance
  const titleLengths = taskDefs.map(t => (t.title || '').length);
  const avgLen = titleLengths.reduce((a, b) => a + b, 0) / titleLengths.length;
  metrics.avgTitleLength = Math.round(avgLen);

  if (avgLen > 0) {
    for (const t of taskDefs) {
      if ((t.title || '').length > avgLen * 3 && (t.title || '').length > 40) {
        warnings.push(`Task "${t.id}" title is unusually long (${(t.title || '').length} chars vs avg ${Math.round(avgLen)}). May need further decomposition.`);
      }
    }
  }

  // Check 4: Parallelism Ratio – Anti-Serial-Collapse Guard
  if (sorted === taskDefs.length && taskDefs.length >= 3) {
    // Compute longest path (critical path depth) via topological DP
    const inDeg2 = {};
    const topoOrder = [];
    const queue2 = [];

    for (const t of taskDefs) { inDeg2[t.id] = 0; }
    for (const t of taskDefs) {
      for (const dep of (t.deps || [])) {
        if (idSet.has(dep)) inDeg2[t.id]++;
      }
    }
    for (const t of taskDefs) {
      if (inDeg2[t.id] === 0) queue2.push(t.id);
    }
    while (queue2.length > 0) {
      const node = queue2.shift();
      topoOrder.push(node);
      for (const t of taskDefs) {
        if ((t.deps || []).includes(node)) {
          inDeg2[t.id]--;
          if (inDeg2[t.id] === 0) queue2.push(t.id);
        }
      }
    }

    const depth = {};
    for (const id of topoOrder) {
      const t = taskDefs.find(x => x.id === id);
      const depDepths = (t.deps || []).filter(d => idSet.has(d)).map(d => depth[d] || 0);
      depth[id] = depDepths.length > 0 ? Math.max(...depDepths) + 1 : 0;
    }
    const criticalPath = Math.max(...Object.values(depth), 0);
    metrics.criticalPath = criticalPath;
    metrics.parallelismRatio = taskDefs.length > 1 ? taskDefs.length / (criticalPath + 1) : 1;

    if (criticalPath >= taskDefs.length * 0.8 && taskDefs.length >= 4) {
      warnings.push(`Task graph is nearly serial (critical path ${criticalPath}/${taskDefs.length}). ` +
        `Parallelism limited. Consider restructuring dependencies for better concurrency.`);
    }
  }

  return { issues, warnings, metrics };
}

// ─── Cross-Task Coherence Check ───────────────────────────────────────────────

/**
 * Checks coherence between outputs of related tasks.
 * Detects naming conflicts, interface mismatches, and output contradictions.
 *
 * @param {Array} completedTasks - Array of completed task objects with outputs
 * @param {Object} options - Options for coherence checking
 * @returns {Object} { issues: string[], warnings: string[], coherence: number }
 */
function checkCrossTaskCoherence(completedTasks, options = {}) {
  const issues = [];
  const warnings = [];
  let coherence = 1.0;

  if (!completedTasks || completedTasks.length < 2) {
    return { issues, warnings, coherence };
  }

  // Collect all output identifiers
  const allIdentifiers = new Map(); // identifier -> { task, count }
  const allApis = new Map(); // apiPath -> { task, method }

  for (const task of completedTasks) {
    const output = task.output || '';

    // Extract potential identifiers (camelCase, PascalCase, snake_case)
    const identifiers = output.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) || [];
    for (const id of identifiers) {
      if (!allIdentifiers.has(id)) {
        allIdentifiers.set(id, { task: task.id, count: 0 });
      }
      allIdentifiers.get(id).count++;
    }

    // Extract API endpoints
    const apiMatches = output.match(/(?:GET|POST|PUT|DELETE|PATCH)\s+['"`]([^'"`]+)['"`]/gi) || [];
    for (const match of apiMatches) {
      const apiPath = match.replace(/['"`]/g, '').toUpperCase();
      if (allApis.has(apiPath)) {
        issues.push(`Duplicate API endpoint: ${apiPath} defined in tasks "${allApis.get(apiPath).task}" and "${task.id}"`);
        coherence -= 0.1;
      } else {
        allApis.set(apiPath, { task: task.id });
      }
    }
  }

  // Check for naming conflicts (same word used with different casing)
  const lowerToOriginals = new Map();
  for (const [id, meta] of allIdentifiers) {
    const lower = id.toLowerCase();
    if (!lowerToOriginals.has(lower)) {
      lowerToOriginals.set(lower, new Set());
    }
    lowerToOriginals.get(lower).add(id);
  }

  for (const [lower, originals] of lowerToOriginals) {
    if (originals.size > 1) {
      const variants = Array.from(originals);
      if (variants.some(v => v !== variants[0])) {
        warnings.push(`Naming inconsistency: "${lower}" appears as ${variants.slice(0, 3).join(', ')}`);
        coherence -= 0.05;
      }
    }
  }

  coherence = Math.max(0, coherence);
  return { issues, warnings, coherence };
}

// ─── Requirement Coverage Check ───────────────────────────────────────────────

/**
 * Checks whether completed tasks cover the original requirement.
 *
 * @param {string} requirement - Original requirement text
 * @param {Array} completedTasks - Array of completed task objects
 * @returns {Object} { covered: boolean, coverage: number, gaps: string[] }
 */
function checkRequirementCoverage(requirement, completedTasks) {
  if (!requirement) {
    return { covered: true, coverage: 100, gaps: [] };
  }

  const reqWords = extractSignificantWords(requirement);
  const coveredWords = new Set();

  for (const task of completedTasks) {
    const taskWords = extractSignificantWords(task.title + ' ' + (task.description || '') + ' ' + (task.output || ''));
    for (const word of taskWords) {
      if (reqWords.includes(word)) {
        coveredWords.add(word);
      }
    }
  }

  const coverage = reqWords.length > 0 ? Math.round((coveredWords.size / reqWords.length) * 100) : 100;
  const gaps = reqWords.filter(w => !coveredWords.has(w)).slice(0, 10);

  return {
    covered: coverage >= 60,
    coverage,
    gaps,
  };
}

// ─── Progress Beacon Builder ──────────────────────────────────────────────────

/**
 * Status icons for progress beacon display.
 */
const STATUS_ICONS = {
  done:        '✅',
  running:     '🔄',
  pending:     '⬜',
  blocked:     '🚫',
  failed:      '❌',
  exhausted:   '💀',
  interrupted: '⏸️',
};

/**
 * Builds a compact progress snapshot (Progress Beacon) for injection into task prompts.
 * Helps agents understand overall progress and remaining work.
 *
 * @param {Array} allTasks - Array of all tasks (from TaskManager)
 * @param {string} currentTaskId - ID of currently executing task
 * @returns {string} Markdown progress beacon block
 */
function buildProgressBeacon(allTasks, currentTaskId) {
  if (!allTasks || allTasks.length === 0) return '';

  const doneCount = allTasks.filter(t => t.status === 'done').length;
  const totalCount = allTasks.length;

  const lines = [
    `## 📍 Progress Beacon (${doneCount}/${totalCount} done)`,
    '',
  ];

  for (const task of allTasks) {
    const icon = task.id === currentTaskId
      ? '🔄'
      : (STATUS_ICONS[task.status] || '⬜');
    const label = task.id === currentTaskId
      ? 'IN PROGRESS (current)'
      : task.status.toUpperCase();
    const title = (task.title || '').slice(0, 60);
    lines.push(`${icon} ${task.id}: ${title} — ${label}`);
  }

  lines.push('');
  lines.push(`> ⚠️ You are executing task **${currentTaskId}**. After completing this task, there are **${totalCount - doneCount - 1}** remaining task(s). Do NOT forget them.`);

  return lines.join('\n');
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  // Stopwords
  DECOMP_STOPWORDS,

  // Keyword extraction
  extractSignificantWords,

  // Validation functions
  validateDecomposition,
  checkCrossTaskCoherence,
  checkRequirementCoverage,

  // Progress beacon
  buildProgressBeacon,
  STATUS_ICONS,
};
