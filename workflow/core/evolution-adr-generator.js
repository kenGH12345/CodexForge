/**
 * Evolution ADR Generator – Creates Architecture Decision Records from triggered patterns
 *
 * Extracted from evolution-recommender.js (ADR-33 Phase 4) to isolate the
 * ADR generation logic from the queue management and facade.
 *
 * This module provides:
 *   - ADRGenerator class – Generates ADR documents from triggered patterns
 *
 * @module evolution-adr-generator
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { REFACTORING_TEMPLATES } = require('./evolution-refactoring-templates');

// ─── ADR Generator ──────────────────────────────────────────────────────────

/**
 * ADR Generator – Creates Architecture Decision Records from triggered patterns.
 *
 * Generates ADR documents following project standard format:
 *   ADR-XXX: Title
 *   Status: Proposed
 *   Context: Pattern detection evidence and rationale
 *   Decision: Specific architecture change
 *   Consequences: Impact analysis
 */
class ADRGenerator {
  constructor(options = {}) {
    this.outputDir = options.outputDir || './docs/adr';
    this.nextAdrNumber = options.nextAdrNumber || this._detectNextAdrNumber();
    this.generatedADRs = [];
  }

  /**
   * Detect the next available ADR number from existing files.
   * @private
   */
  _detectNextAdrNumber() {
    try {
      if (!fs.existsSync(this.outputDir)) return 1;

      const files = fs.readdirSync(this.outputDir);
      const numbers = files
        .filter(f => f.match(/^ADR-(\d+)/))
        .map(f => parseInt(f.match(/^ADR-(\d+)/)[1]));

      return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
    } catch (err) {
      return 1;
    }
  }

  /**
   * Generate ADR for a triggered pattern.
   *
   * @param {TriggeredPattern} triggeredPattern
   * @param {PatternTrend} [trend]
   * @returns {ADRProposal}
   */
  generate(triggeredPattern, trend = null) {
    const template = REFACTORING_TEMPLATES[triggeredPattern.patternId];
    const adrNumber = this.nextAdrNumber++;

    const adr = {
      id: `ADR-${String(adrNumber).padStart(3, '0')}`,
      number: adrNumber,
      status: 'Proposed',
      title: this._generateTitle(triggeredPattern, template),
      context: this._generateContext(triggeredPattern, trend),
      decision: this._generateDecision(triggeredPattern, template),
      consequences: this._generateConsequences(triggeredPattern, template),
      migrationImpact: this._generateMigrationImpact(triggeredPattern, template),
      rollbackStrategy: this._generateRollbackStrategy(triggeredPattern, template),
      generatedAt: new Date().toISOString(),
      metadata: {
        patternId: triggeredPattern.patternId,
        patternName: triggeredPattern.patternName,
        occurrenceCount: triggeredPattern.occurrenceCount,
        severity: triggeredPattern.severity,
        velocity: trend?.velocity || 0,
        confidence: triggeredPattern.confidence,
      },
    };

    this.generatedADRs.push(adr);
    return adr;
  }

  /** @private */
  _generateTitle(triggeredPattern, template) {
    if (template) {
      return `Adopt ${template.architecturalPattern} to resolve ${triggeredPattern.patternName}`;
    }
    return `Address ${triggeredPattern.patternName} through architecture evolution`;
  }

  /** @private */
  _generateContext(triggeredPattern, trend) {
    const lines = [
      '## Context',
      '',
      `**Pattern Detected**: ${triggeredPattern.patternName}`,
      `**Pattern ID**: ${triggeredPattern.patternId}`,
      `**Occurrences**: ${triggeredPattern.occurrenceCount} (threshold: ${triggeredPattern.threshold})`,
      '',
      '### Evidence',
      '',
      `The pattern has been detected ${triggeredPattern.occurrenceCount} times across recent experience records.`,
      '',
    ];

    if (trend) {
      lines.push(
        '### Trend Analysis',
        '',
        `- **Velocity**: ${trend.velocity} occurrences/week`,
        `- **Growth Rate**: ${trend.growthRate}%`,
        `- **Trend Direction**: ${trend.trend}`,
        ''
      );
    }

    lines.push(
      '### Problem Statement',
      '',
      'The repeated occurrence of this pattern indicates a structural issue in the architecture.',
      'Without intervention, this pattern will continue to require similar fixes, increasing',
      'maintenance burden and architectural entropy.',
      ''
    );

    return lines.join('\n');
  }

  /** @private */
  _generateDecision(triggeredPattern, template) {
    const lines = ['## Decision', ''];

    if (template) {
      lines.push(
        `**Decision**: ${template.refactoringName}`,
        '',
        '### Approach',
        '',
        template.description,
        '',
        '### Implementation Plan',
        ''
      );

      template.implementationPlan.forEach(step => {
        lines.push(
          `#### Step ${step.step}: ${step.title}`,
          '',
          step.description,
          ''
        );

        if (step.exampleFile) {
          lines.push(`**File**: \`${step.exampleFile}\``);
        }

        if (step.code) {
          lines.push('', '```javascript', step.code, '```', '');
        }
      });
    } else {
      lines.push(
        `**Decision**: ${triggeredPattern.recommendation}`,
        '',
        'Specific implementation details to be determined based on code analysis.',
        ''
      );
    }

    return lines.join('\n');
  }

  /** @private */
  _generateConsequences(triggeredPattern, template) {
    const lines = ['## Consequences', ''];

    lines.push('### Positive', '');

    if (template?.benefits) {
      template.benefits.forEach(benefit => {
        lines.push(`- ${benefit}`);
      });
    } else {
      lines.push('- Reduces recurring maintenance tasks');
      lines.push('- Improves code maintainability');
      lines.push('- Reduces architectural entropy');
    }

    lines.push('');

    lines.push('### Risks', '');

    if (template?.effort) {
      lines.push(`- **Effort Required**: ~${template.effort.estimatedHours} hours`);
      lines.push(`- **Complexity**: ${template.effort.complexity}`);
      lines.push(`- **Implementation Risk**: ${template.effort.riskLevel}`);
    } else {
      lines.push('- Implementation effort required');
      lines.push('- Potential for regression during refactoring');
    }

    lines.push(
      '',
      '### Monitoring',
      '',
      'After implementation, the Problem Abstraction Engine will monitor for:',
      `- Reduction in ${triggeredPattern.patternName} occurrences`,
      '- Overall architecture entropy trends',
      ''
    );

    return lines.join('\n');
  }

  _generateMigrationImpact(triggeredPattern, template) {
    return {
      affectedComponents: template?.effort ? ['see implementation plan'] : ['to be determined'],
      dataMigration: 'Assessment required — check runtime/projection compatibility',
      backwardCompatibility: 'Must be validated against ProjectionContractValidator',
      estimatedEffort: template?.effort ? `${template.effort.estimatedHours}h` : 'TBD',
    };
  }

  _generateRollbackStrategy(triggeredPattern, template) {
    return {
      approach: 'Incremental rollback via RollbackCoordinator',
      rollbackTriggers: [`Regression in ${triggeredPattern.patternName} metrics`, 'Quality gate failure'],
      dataRecovery: 'Event-sourced replay from RuntimeEventStore',
      validationSteps: ['Run architecture fitness gates', 'Verify projection contract compliance'],
    };
  }

  /**
   * Render ADR as markdown document.
   *
   * @param {ADRProposal} adr
   * @returns {string}
   */
  renderMarkdown(adr) {
    const lines = [
      `# ${adr.id}: ${adr.title}`,
      '',
      `**Status**: ${adr.status}`,
      `**Generated**: ${new Date(adr.generatedAt).toLocaleString()}`,
      '',
      `> **Triggered by**: ${adr.metadata.patternName}`,
      `> **Occurrences**: ${adr.metadata.occurrenceCount} | **Severity**: ${adr.metadata.severity}`,
      '',
      '---',
      '',
      adr.context,
      '',
      adr.decision,
      '',
      adr.consequences,
      '',
    ];

    if (adr.migrationImpact) {
      lines.push(
        '## Migration Impact', '',
        `- **Affected Components**: ${adr.migrationImpact.affectedComponents.join(', ')}`,
        `- **Data Migration**: ${adr.migrationImpact.dataMigration}`,
        `- **Backward Compatibility**: ${adr.migrationImpact.backwardCompatibility}`,
        `- **Estimated Effort**: ${adr.migrationImpact.estimatedEffort}`,
        ''
      );
    }

    if (adr.rollbackStrategy) {
      lines.push(
        '## Rollback Strategy', '',
        `- **Approach**: ${adr.rollbackStrategy.approach}`,
        `- **Rollback Triggers**: ${adr.rollbackStrategy.rollbackTriggers.join('; ')}`,
        `- **Data Recovery**: ${adr.rollbackStrategy.dataRecovery}`,
        `- **Validation Steps**: ${adr.rollbackStrategy.validationSteps.join('; ')}`,
        ''
      );
    }

    lines.push(
      '---',
      '',
      '*Generated by WorkFlowAgent Evolution Recommender*',
    );

    return lines.join('\n');
  }

  /**
   * Save ADR to file.
   *
   * @param {ADRProposal} adr
   * @returns {string} File path
   */
  saveToFile(adr) {
    const filename = `${adr.id}-${adr.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
    const filepath = path.join(this.outputDir, filename);

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    const content = this.renderMarkdown(adr);
    fs.writeFileSync(filepath, content, 'utf-8');

    return filepath;
  }

  /**
   * Get all generated ADRs.
   * @returns {ADRProposal[]}
   */
  getGeneratedADRs() {
    return [...this.generatedADRs];
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  ADRGenerator,
};
