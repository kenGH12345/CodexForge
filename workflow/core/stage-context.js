/**
 * Stage Context — Shared context builder for REQUIRED_OBSERVATION and retry context
 *
 * Provides unified context construction for both IDE Agent mode and
 * Node Orchestrator mode. Eliminates the dual-implementation gap.
 *
 * @module stage-context
 */

'use strict';

const { generatePreStageQuestions } = require('./pre-stage-questions');

const SLOT_HEADINGS = {
  root_cause: '## 根因 / Root Cause',
  change_scope: '## 修改范围 / Change Scope',
  downstream_consumers: '## 下游消费影响 / Downstream Consumers',
  risk_assessment: '## 风险评估 / Risk Assessment',
  scorecard: '## Architecture Scorecard / 架构评分卡',
  failure_model: '## Failure Model / 失败模型',
  migration_safety: '## Migration Safety Case / 迁移安全',
  scenario_coverage: '## Scenario Coverage / 场景覆盖',
  consumer_adoption_design: '## Consumer Adoption Design / 下游消费方案',
};

function describeSchemaRequirements(requiredSchema) {
  if (!requiredSchema) return 'no schema';
  if (Array.isArray(requiredSchema.requiredSlots) && requiredSchema.requiredSlots.length > 0) {
    return requiredSchema.requiredSlots
      .map(slot => `${slot.id}: ${slot.description || 'required semantic slot'}`)
      .join('; ');
  }
  return (requiredSchema.requiredSections || []).join(', ');
}

function headingForSlot(slot) {
  if (!slot || !slot.id) return '## Required Section';
  return slot.heading || slot.displayHeading || SLOT_HEADINGS[slot.id] || `## ${slot.id.replace(/_/g, ' ')}`;
}

function renderRequiredSchemaPrompt(stage, outputPath, requiredSchema) {
  if (!requiredSchema) return null;
  const lines = [
    '',
    `⚠️ ${stage} output schema for ${outputPath} (schema-rendered — stage-complete enforces this):`,
  ];

  if (Array.isArray(requiredSchema.requiredSlots) && requiredSchema.requiredSlots.length > 0) {
    lines.push('Required semantic slots:');
    for (const slot of requiredSchema.requiredSlots) {
      const min = Number.isFinite(slot.minContentLines) ? `; min ${slot.minContentLines} substantive line(s)` : '';
      lines.push(`  ${headingForSlot(slot)} — ${slot.description || slot.id}${min}`);
    }
  } else if (Array.isArray(requiredSchema.requiredSections) && requiredSchema.requiredSections.length > 0) {
    lines.push('Required sections/patterns:');
    for (const section of requiredSchema.requiredSections) lines.push(`  ${section}`);
  }

  if (Array.isArray(requiredSchema.recommendedSections) && requiredSchema.recommendedSections.length > 0) {
    lines.push(`Recommended sections: ${requiredSchema.recommendedSections.join(', ')}`);
  }

  if (Array.isArray(requiredSchema.forbiddenSections) && requiredSchema.forbiddenSections.length > 0) {
    lines.push(`Forbidden sections: ${requiredSchema.forbiddenSections.join(', ')}`);
  }

  if (requiredSchema.evidenceMinMatches > 0) {
    lines.push(`Evidence requirement: include concrete code/tool evidence matching at least ${requiredSchema.evidenceMinMatches} evidence pattern(s).`);
  }

  lines.push('Do not satisfy this with empty headings; each required slot must contain real stage-specific content.');
  return lines.join('\n');
}

function buildRequiredObservation(stage, requirement, options) {
  const opts = options || {};
  const outputPath = opts.outputPath || null;
  const requiredSchema = opts.requiredSchema || null;
  const adr37Enforcement = opts.adr37Enforcement || null;
  const crossStageContext = opts.crossStageContext || null;
  const pendingBlindSpots = opts.pendingBlindSpots || null;
  const requirements = describeSchemaRequirements(requiredSchema);

  return {
    outputPath,
    requiredSchema,
    instruction: requiredSchema
      ? `After completing work, verify output/${requiredSchema.file} satisfies ALL required schema items/semantic slots: ${requirements}. Then call stage-complete.`
      : `After completing work, call stage-complete.`,
    verificationNote: 'stage-complete will HARD-REJECT if artifact is missing or does not satisfy required sections/semantic slots.',
    schemaPrompt: renderRequiredSchemaPrompt(stage, outputPath, requiredSchema),
    adr37Enforcement,
    preStageThinking: generatePreStageQuestions(stage, requirement || ''),
    ...(crossStageContext ? { crossStageContext } : {}),
    ...(pendingBlindSpots && pendingBlindSpots.length > 0 ? { pendingBlindSpots } : {}),
  };
}

function buildRetryContext(previousChallenge, options) {
  if (!previousChallenge && !options) return null;
  const opts = options || {};

  return {
    revisionSummary: previousChallenge?.revisionSummary || null,
    questions: previousChallenge?.questions || opts.socraticQuestions || [],
    blindSpots: previousChallenge?.blindSpots || opts.blindSpots || [],
    previousConfidence: previousChallenge?.previousConfidence || opts.confidence || null,
    triggerReasons: previousChallenge?.triggerReasons || opts.triggerReasons || [],
    p2Protocol: previousChallenge?.p2Protocol || null,
    ...(opts.retryCount !== undefined ? { retryCount: opts.retryCount } : {}),
    ...(opts.maxRetry !== undefined ? { maxRetry: opts.maxRetry } : {}),
    ...(opts.command ? { command: opts.command } : {}),
    ...(opts.instruction ? { instruction: opts.instruction } : {}),
  };
}

module.exports = {
  buildRequiredObservation,
  buildRetryContext,
  describeSchemaRequirements,
  headingForSlot,
  renderRequiredSchemaPrompt,
};
