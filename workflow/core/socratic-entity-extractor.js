/**
 * Socratic Challenger – Entity Extractor & Artifact Structure Analyzer (ADR-56)
 *
 * Extracted from socratic-challenger.js.
 * Handles T1 (entity extraction), T2 (entity-grounded question generation),
 * and the 4-step artifact structure analysis pipeline.
 *
 * @module workflow/core/socratic-entity-extractor
 */

'use strict';

const {
  STAGE_ARTIFACT_SCHEMA,
  QUALITY_CHECK_PATTERNS,
} = require('./socratic-constants');

/**
 * T1: Extract concrete entities from artifact content.
 * @param {string} content - Artifact content
 * @param {string} stageName - Current stage
 * @returns {{ filePaths: string[], functionNames: string[], taskIds: string[], decisions: string[], numbers: string[], riskItems: string[], headings: string[] }}
 */
function extractEntities(content, stageName) {
  const text = String(content || '');
  const entities = {
    filePaths: [],
    functionNames: [],
    taskIds: [],
    decisions: [],
    numbers: [],
    riskItems: [],
    headings: [],
  };

  // File paths
  const pathRe = /(?:[\w-]+\/)+[\w.-]+\.\w{1,5}/g;
  let m;
  while ((m = pathRe.exec(text)) !== null) {
    if (!entities.filePaths.includes(m[0])) entities.filePaths.push(m[0]);
  }

  // Function/method names
  const funcRe = /(?:function\s+|(?:async\s+)?(?:_?\w+)\s*\(|`(\w+(?:\.\w+)*)\(\)`)/g;
  while ((m = funcRe.exec(text)) !== null) {
    const name = m[1] || m[0].replace(/\s*\($/, '').replace(/^(?:async\s+|function\s+)/, '').trim();
    if (name.length > 2 && name.length < 60 && !entities.functionNames.includes(name)) {
      entities.functionNames.push(name);
    }
  }

  // Task IDs
  const taskRe = /(?:T-?\d+|Task\s*\d+|任务\s*\d+)/gi;
  while ((m = taskRe.exec(text)) !== null) {
    const tid = m[0].trim();
    if (!entities.taskIds.includes(tid)) entities.taskIds.push(tid);
  }

  // Decisions
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (/(?:选择|决定|采用|选型|trade.?off|权衡|chose|decided|selected|prefer|recommend)/i.test(trimmed)) {
      const decision = trimmed.replace(/^[-*#>\s]+/, '').slice(0, 120);
      if (decision.length > 10 && entities.decisions.length < 5) {
        entities.decisions.push(decision);
      }
    }
  }

  // Quantitative values
  const numRe = /\d+(?:\.\d+)?(?:\s*(?:%|ms|s|KB|MB|GB|QPS|TPS|次|个|项|条|行))/g;
  while ((m = numRe.exec(text)) !== null) {
    if (!entities.numbers.includes(m[0])) entities.numbers.push(m[0]);
  }

  // Risk items
  for (const line of lines) {
    const trimmed = line.trim();
    if (/(?:风险|risk|限制|limitation|约束|constraint|注意|caveat|warning|⚠)/i.test(trimmed)) {
      const risk = trimmed.replace(/^[-*#>\s]+/, '').slice(0, 120);
      if (risk.length > 10 && entities.riskItems.length < 5) {
        entities.riskItems.push(risk);
      }
    }
  }

  // Headings
  const headingRe = /^(#{1,4})\s+(.+)/gm;
  while ((m = headingRe.exec(text)) !== null) {
    const title = m[2].trim();
    if (title.length > 3) entities.headings.push(title);
  }

  return entities;
}

/**
 * T2: Generate entity-grounded Socratic questions.
 * @param {object} entities - Extracted entities
 * @param {string} stageName - Current stage
 * @param {string} content - Artifact content
 * @param {string} requirement - Original requirement
 * @param {Function} truncateFn - Truncation helper
 * @returns {{ question: string, reasonTag: string }[]}
 */
function generateEntityGroundedQuestions(entities, stageName, content, requirement, truncateFn) {
  const _truncate = truncateFn || ((s, n) => String(s || '').slice(0, n));
  const questions = [];
  const contentLower = String(content || '').toLowerCase();
  const reqText = requirement ? `"${_truncate(requirement, 50)}"` : '当前任务';

  // Q1: File paths mentioned but no change rationale
  if (entities.filePaths.length > 0) {
    const unexplainedFiles = entities.filePaths.filter(fp => {
      const fpLower = fp.toLowerCase();
      const idx = contentLower.indexOf(fpLower);
      if (idx < 0) return false;
      const surrounding = contentLower.slice(Math.max(0, idx - 200), idx + fp.length + 200);
      return !/(?:因为|由于|because|since|原因|reason|需要.*修改|修改.*以)/i.test(surrounding);
    });
    if (unexplainedFiles.length > 0) {
      const fileList = unexplainedFiles.slice(0, 2).join('、');
      questions.push({
        question: `[${stageName}] 提到修改 ${fileList}，但未说明修改原因。对于${reqText}，为什么需要修改这些文件而非其他文件？`,
        reasonTag: 'entity_file_rationale',
      });
    }
  }

  // Q2: Decisions without alternatives
  if (entities.decisions.length > 0) {
    for (const decision of entities.decisions.slice(0, 2)) {
      if (!/(?:替代|备选|alternative|也可以|另一种|other option|vs\b|对比)/i.test(decision.toLowerCase())) {
        questions.push({
          question: `[${stageName}] 决策"${_truncate(decision, 60)}"——考虑过哪些替代方案？为什么排除了它们？`,
          reasonTag: 'entity_decision_alternatives',
        });
        break;
      }
    }
  }

  // Q3: Tasks without dependency/risk analysis
  if (entities.taskIds.length >= 2) {
    const hasDependency = /(?:依赖|depend|先.*后|阻塞|block|前置|prerequisite)/i.test(contentLower);
    if (!hasDependency) {
      const taskList = entities.taskIds.slice(0, 3).join('、');
      questions.push({
        question: `[${stageName}] 定义了 ${taskList} 等任务，但未说明它们之间的依赖关系。如果 ${entities.taskIds[0]} 失败或延迟，对后续任务的影响是什么？`,
        reasonTag: 'entity_task_dependency',
      });
    }
  }

  // Q4: Numbers without context/justification
  if (entities.numbers.length > 0) {
    for (const num of entities.numbers.slice(0, 2)) {
      const numIdx = contentLower.indexOf(num.toLowerCase());
      if (numIdx >= 0) {
        const surrounding = contentLower.slice(Math.max(0, numIdx - 150), numIdx + num.length + 150);
        if (!/(?:因为|基于|根据|based on|according|测试|测量|benchmark)/i.test(surrounding)) {
          questions.push({
            question: `[${stageName}] 提到 ${num}，这个数值的依据是什么？是实测数据还是估算？`,
            reasonTag: 'entity_number_justification',
          });
          break;
        }
      }
    }
  }

  // Q5: Risk items without mitigation
  if (entities.riskItems.length > 0) {
    for (const risk of entities.riskItems.slice(0, 2)) {
      if (!/(?:缓解|规避|mitigation|workaround|fallback|回滚|降级|解决方案)/i.test(risk.toLowerCase())) {
        questions.push({
          question: `[${stageName}] 识别了风险"${_truncate(risk, 60)}"，但未提供缓解措施。如果该风险发生，回退策略是什么？`,
          reasonTag: 'entity_risk_mitigation',
        });
        break;
      }
    }
  }

  // Q6: Multiple files modified but no integration/regression concern
  if (entities.filePaths.length >= 3) {
    const hasIntegrationConcern = /(?:集成|integration|回归|regression|联调|端到端|e2e)/i.test(contentLower);
    if (!hasIntegrationConcern) {
      questions.push({
        question: `[${stageName}] 涉及 ${entities.filePaths.length} 个文件的修改，但未提及集成测试或回归风险。这些修改之间的交互是否经过验证？`,
        reasonTag: 'entity_integration_risk',
      });
    }
  }

  return questions.slice(0, 4);
}

// ─── Artifact Structure Analyzer (4-step pipeline) ────────────────────────────

/**
 * Extract structured representation of artifact content.
 * @param {string} content - Raw artifact content
 * @param {string} stageName - Stage name
 * @param {Function} truncateFn - Truncation helper
 * @returns {{ headings: object[], schemaGaps: object[], anchoredQuestions: object[] }}
 */
function extractArtifactStructure(content, stageName, truncateFn) {
  const text = String(content || '');

  if (text.includes('[LIGHTWEIGHT]')) {
    return { headings: [], schemaGaps: [], anchoredQuestions: [] };
  }

  const headings = parseHeadingTree(text);

  for (const h of headings) {
    h.contentType = classifySectionContent(h.bodyText);
    h.wordCount = (h.bodyText || '').split(/\s+/).filter(Boolean).length;
  }

  const schema = STAGE_ARTIFACT_SCHEMA[stageName];
  const schemaGaps = schema ? findSchemaGaps(headings, schema) : [];
  const anchoredQuestions = generateAnchoredQuestions(schemaGaps, stageName, headings, truncateFn);

  return { headings, schemaGaps, anchoredQuestions };
}

/**
 * Step 1: Parse Markdown content into a heading tree.
 */
function parseHeadingTree(text) {
  const lines = text.split('\n');
  const headings = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (match) {
      if (headings.length > 0) {
        const prev = headings[headings.length - 1];
        prev.endLine = i - 1;
        prev.bodyText = lines.slice(prev.startLine + 1, i).join('\n').trim();
      }
      headings.push({
        level: match[1].length,
        title: match[2].trim(),
        startLine: i,
        endLine: lines.length - 1,
        bodyText: '',
      });
    }
  }

  if (headings.length > 0) {
    const last = headings[headings.length - 1];
    last.endLine = lines.length - 1;
    last.bodyText = lines.slice(last.startLine + 1).join('\n').trim();
  }

  return headings;
}

/**
 * Step 2: Classify section content type.
 */
function classifySectionContent(bodyText) {
  const text = String(bodyText || '').toLowerCase();
  const patterns = {
    risk: /风险|问题|缺陷|risk|issue|defect|vulnerability|P[012]/,
    conclusion: /结论|因此|所以|综上|therefore|conclude|in\s*summary|root\s*cause|根因/,
    evidence: /证据|数据|测试|结果|evidence|data|test|result|benchmark|实测/,
    assumption: /假设|前提|如果|假定|assume|premise|if\s+we/,
    decision: /决定|选择|方案|设计|决策|decide|choose|design|approach|trade.?off/,
  };

  for (const [type, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) return type;
  }
  return 'unknown';
}

/**
 * Step 3: Compare parsed headings against stage schema to find gaps.
 */
function findSchemaGaps(headings, schema) {
  if (!schema || !Array.isArray(schema.expectedSections)) return [];

  const gaps = [];

  for (const expected of schema.expectedSections) {
    const matched = headings.find(h => expected.heading.test(h.title));

    if (!matched) {
      gaps.push({
        section: expected.label || String(expected.heading),
        status: 'missing',
        severity: expected.required ? 'missing_required' : 'missing_optional',
        reason: `Expected section "${expected.label}" not found in artifact`,
      });
      continue;
    }

    if (expected.minWords && matched.wordCount < expected.minWords) {
      gaps.push({
        section: expected.label || matched.title,
        status: 'weak',
        severity: 'weak_content',
        reason: `Section "${matched.title}" has ${matched.wordCount} words (min: ${expected.minWords})`,
        line: matched.startLine + 1,
      });
      continue;
    }

    const failedChecks = [];
    for (const checkName of (expected.qualityChecks || [])) {
      const pattern = QUALITY_CHECK_PATTERNS[checkName];
      if (pattern && !pattern.test(matched.bodyText)) {
        failedChecks.push(checkName);
      }
    }

    if (failedChecks.length > 0) {
      gaps.push({
        section: expected.label || matched.title,
        status: 'weak',
        severity: 'weak_content',
        reason: `Section "${matched.title}" missing quality signals: ${failedChecks.join(', ')}`,
        line: matched.startLine + 1,
        failedChecks,
      });
    }
  }

  // E3: Rule fallback — untested assumption detection
  const assumptionSignals = /假设|前提|假定|assume|premise|if\s+we|预计|估计/i;
  const verificationSignals = /验证|证实|测试|数据表明|实测|verified|tested|confirmed|evidence/i;
  for (const h of headings) {
    if (assumptionSignals.test(h.bodyText) && !verificationSignals.test(h.bodyText)) {
      const alreadyFlagged = gaps.some(g => g.section === h.title);
      if (!alreadyFlagged) {
        gaps.push({
          section: h.title,
          status: 'untested_assumption',
          severity: 'untested_assumption',
          reason: `Section "${h.title}" contains assumption signals but no verification evidence`,
          line: h.startLine + 1,
        });
      }
    }
  }

  // E3: Rule fallback — quantitative claim without numbers
  const quantitativeSignals = /预计|大约|约|估计|approximately|roughly|expected|目标.*达到/i;
  const hasNumbers = /\d+/;
  for (const h of headings) {
    if (quantitativeSignals.test(h.bodyText) && !hasNumbers.test(h.bodyText)) {
      const alreadyFlagged = gaps.some(g => g.section === h.title);
      if (!alreadyFlagged) {
        gaps.push({
          section: h.title,
          status: 'weak_evidence',
          severity: 'weak_evidence',
          reason: `Section "${h.title}" has quantitative claims but no specific numbers`,
          line: h.startLine + 1,
        });
      }
    }
  }

  return gaps;
}

/**
 * Step 4: Generate anchored Socratic questions for each schema gap.
 */
function generateAnchoredQuestions(schemaGaps, stageName, headings, truncateFn) {
  const _truncate = truncateFn || ((s, n) => String(s || '').slice(0, n));
  const questions = [];

  for (const gap of schemaGaps) {
    let question;
    const excerptText = extractSourceExcerpt(gap, headings);
    const excerptRef = excerptText ? `原文：「${excerptText}」——` : '';

    if (gap.status === 'missing') {
      question = `[Schema缺口][${stageName}] artifact 中缺少"${gap.section}"部分。`
        + (gap.severity === 'missing_required'
          ? `这是必需 section，缺失会导致后续阶段缺乏关键输入。请补充。`
          : `这是可选 section，但补充后能提升产物完整性。`);
    } else if (gap.status === 'weak') {
      const lineRef = gap.line ? `（第 ${gap.line} 行附近）` : '';
      if (gap.failedChecks && gap.failedChecks.length > 0) {
        const checkLabels = gap.failedChecks.map(c => c.replace(/_/g, ' ')).join('、');
        question = `[内容锚定][${stageName}] "${gap.section}"${lineRef}内容不够充分：缺少 ${checkLabels}。`
          + `${excerptRef}当前内容是否足以支撑后续阶段的决策？`;
      } else {
        question = `[内容锚定][${stageName}] "${gap.section}"${lineRef}内容过于简短（${gap.reason}）。`
          + `${excerptRef}是否遗漏了关键信息？`;
      }
    } else if (gap.status === 'untested_assumption') {
      question = `[假设验证][${stageName}] "${gap.section}"中存在未验证的假设：${excerptRef}`
        + `该假设的依据是什么？如何验证？`;
    } else if (gap.status === 'weak_evidence') {
      question = `[量化缺失][${stageName}] "${gap.section}"中存在量化声明但缺少具体数值：${excerptRef}`
        + `请提供具体的数据支撑。`;
    }

    if (question) {
      questions.push({
        question,
        anchorSection: gap.section,
        anchorLine: gap.line || 0,
        severity: gap.severity,
      });
    }
  }

  return questions;
}

/**
 * E1: Extract a source excerpt from the heading's bodyText for content anchoring.
 */
function extractSourceExcerpt(gap, headings) {
  if (!gap || !headings || headings.length === 0) return '';

  const heading = headings.find(h =>
    h.title === gap.section ||
    (gap.section && h.title && h.title.includes(gap.section))
  );
  if (!heading || !heading.bodyText) return '';

  const body = heading.bodyText.trim();
  if (!body) return '';

  const MAX_LEN = 60;
  const sentenceEnd = body.search(/[。\n.!？]/);
  if (sentenceEnd > 0 && sentenceEnd <= MAX_LEN) {
    return body.slice(0, sentenceEnd + 1).trim();
  }
  if (body.length <= MAX_LEN) return body;
  return body.slice(0, MAX_LEN) + '…';
}

// ─── Module Exports ───────────────────────────────────────────────────────────

module.exports = {
  extractEntities,
  generateEntityGroundedQuestions,
  extractArtifactStructure,
  parseHeadingTree,
  classifySectionContent,
  findSchemaGaps,
  generateAnchoredQuestions,
  extractSourceExcerpt,
};
