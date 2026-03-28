/**
 * Phase 2 Demo: Evolution Recommender
 *
 * Demonstrates ADR generation, refactoring guidance, and architecture
 * change queue management for Problem Abstraction Engine.
 *
 * Scenario: Team has accumulated 5 hardcoded IDE fixes,
 * triggering automatic ADR-XXX proposal for Provider Pattern migration.
 */

'use strict';

const path = require('path');
const { ExperienceStore } = require('../core/experience-store');
const { ExperienceType, ExperienceCategory } = require('../core/experience-types');

// ─── Demo Configuration ─────────────────────────────────────────────────────

const DEMO_OUTPUT_DIR = path.join(__dirname, '../../output/demo-phase2');

// ─── Helper Functions ───────────────────────────────────────────────────────

function createHardcodedExperience(ideName, timestamp) {
  return {
    type: ExperienceType.NEGATIVE,
    category: ExperienceCategory.CONFIG_SYSTEM,
    title: `Fix: Add ${ideName} IDE detection`,
    content: `Added ${ideName} to the hardcoded IDE_SIGNATURES object. ` +
             `This is the 5th IDE added this quarter - maintenance burden increasing.`,
    codeExample: `const IDE_SIGNATURES = {
  // ... existing entries
  ${ideName.toLowerCase()}: {
    name: '${ideName}',
    envVars: ['${ideName.toUpperCase()}_SESSION'],
  },
};`,
    tags: ['ide', 'hardcoded', 'config'],
  };
}

// ─── Demo Scenarios ─────────────────────────────────────────────────────────

async function runDemo() {
  console.log('\n' + '='.repeat(70));
  console.log('  Phase 2 Demo: Evolution Recommender');
  console.log('  ADR Generation + Refactoring Guidance + Change Queue');
  console.log('='.repeat(70) + '\n');

  // Initialize experience store
  const store = new ExperienceStore(path.join(DEMO_OUTPUT_DIR, 'experiences.json'));

  console.log('Scenario: Team keeps adding new IDE support\n');
  console.log('Simulating 5 hardcoded IDE fixes over 8 weeks...\n');

  const ideFixes = [
    { name: 'Trae', daysAgo: 56 },
    { name: 'Zed', daysAgo: 42 },
    { name: 'KimiCode', daysAgo: 28 },
    { name: 'PearAI', daysAgo: 14 },
    { name: 'VoidEditor', daysAgo: 2 },
  ];

  for (const fix of ideFixes) {
    const timestamp = Date.now() - fix.daysAgo * 24 * 60 * 60 * 1000;
    const exp = createHardcodedExperience(fix.name, timestamp);
    exp.createdAt = new Date(timestamp).toISOString();

    const recorded = store.recordWithAbstraction(exp);
    console.log(`📋 Recorded: ${exp.title} (${fix.daysAgo} days ago)`);

    if (recorded.patternCheck.triggeredPatterns.length > 0) {
      console.log(`   🔴 TRIGGERED: Patterns reaching threshold!`);
    }
  }

  console.log('\n' + '-'.repeat(70));
  console.log('Running full analysis with ADR generation...');
  console.log('-'.repeat(70) + '\n');

  const analysis = store.analyzeAbstractions();

  console.log('📊 Analysis Summary:');
  console.log(`   Total experiences: ${analysis.summary.totalExperiencesAnalyzed}`);
  console.log(`   Patterns triggered: ${analysis.summary.patternsTriggered}`);
  console.log(`   Health status: ${analysis.summary.healthStatus}`);
  console.log(`   ADR proposals: ${analysis.summary.adrProposalsGenerated}`);
  console.log();

  if (analysis.adrProposals?.length > 0) {
    console.log('='.repeat(70));
    console.log('ADR Proposals Generated');
    console.log('='.repeat(70) + '\n');

    for (const { adr, proposal, refactoringGuide, summary } of analysis.adrProposals) {
      console.log(`📄 ${adr.id}: ${adr.title}`);
      console.log(`   Status: ${adr.status}`);
      console.log(`   Priority: ${proposal.priority}`);
      console.log(`   Queue ID: ${proposal.id}`);
      console.log();

      console.log('   Context:');
      console.log(`     Pattern: ${adr.metadata.patternName}`);
      console.log(`     Occurrences: ${adr.metadata.occurrenceCount}`);
      console.log(`     Confidence: ${(adr.metadata.confidence * 100).toFixed(1)}%`);
      console.log(`     Velocity: ${adr.metadata.velocity.toFixed(2)}/week`);
      console.log();

      if (refactoringGuide) {
        console.log('   Refactoring Guidance:');
        console.log(`     Name: ${refactoringGuide.name}`);
        console.log(`     Pattern: ${refactoringGuide.architecturalPattern}`);
        console.log(`     Estimated Effort: ${refactoringGuide.effort.estimatedHours} hours`);
        console.log(`     Complexity: ${refactoringGuide.effort.complexity}`);
        console.log(`     Risk: ${refactoringGuide.effort.riskLevel}`);
        console.log();

        console.log('   Key Benefits:');
        refactoringGuide.benefits.slice(0, 3).forEach(benefit => {
          console.log(`     • ${benefit}`);
        });
        console.log();

        console.log('   Implementation Steps:');
        refactoringGuide.implementationPlan.forEach(step => {
          console.log(`     ${step.step}. ${step.title}`);
          if (step.exampleFile) {
            console.log(`        → ${step.exampleFile}`);
          }
        });
        console.log();
      }

      console.log('   Action Status:', summary.actionRequired ? '⚠️ IMMEDIATE' : '✅ Can be scheduled');
      console.log('-'.repeat(50));
      console.log();
    }

    // Generate and save ADR file
    console.log('Saving ADR to file...\n');
    const adrPath = store.generateADR('HARDCODED_CONFIG_ENTRY');
    if (adrPath) {
      console.log(`✅ ADR saved to: ${adrPath}`);
    }
  }

  // Queue statistics
  console.log();
  console.log('='.repeat(70));
  console.log('Architecture Change Queue Status');
  console.log('='.repeat(70) + '\n');

  const queueStats = store.getArchitectureQueueStats();
  console.log(`Total proposals: ${queueStats.total}`);
  console.log(`By Status:`);
  console.log(`  • Queued: ${queueStats.byStatus.queued}`);
  console.log(`  • In Review: ${queueStats.byStatus.inReview}`);
  console.log(`  • Approved: ${queueStats.byStatus.approved}`);
  console.log(`  • In Progress: ${queueStats.byStatus.inProgress}`);
  console.log(`  • Implemented: ${queueStats.byStatus.implemented}`);
  console.log(`By Priority:`);
  console.log(`  • P0 (Critical): ${queueStats.byPriority.P0}`);
  console.log(`  • P1 (High): ${queueStats.byPriority.P1}`);
  console.log(`  • P2 (Medium): ${queueStats.byPriority.P2}`);
  console.log(`  • P3 (Low): ${queueStats.byPriority.P3}`);

  // Pending proposals
  const pending = store.getPendingArchitectureProposals();
  if (pending.length > 0) {
    console.log();
    console.log('Pending Proposals:');
    pending.forEach(p => {
      console.log(`  [${p.priority}] ${p.patternName} (${p.status})`);
    });
  }

  // Refactoring guide
  console.log();
  console.log('='.repeat(70));
  console.log('Detailed Refactoring Guide');
  console.log('='.repeat(70) + '\n');

  const guide = store.getRefactoringGuide('HARDCODED_CONFIG_ENTRY');
  if (guide) {
    console.log('BEFORE (Current Problematic Code):');
    console.log('─────────────────────────────────────');
    console.log(guide.beforeExample);
    console.log();

    console.log('AFTER (Provider Pattern Solution):');
    console.log('─────────────────────────────────────');
    console.log(guide.afterExample);
    console.log();

    console.log('Implementation Checklist:');
    const checklist = [
      '[ ] Create Provider Registry Module',
      '[ ] Extract IDE Provider',
      '[ ] Migrate existing hardcoded entries',
      '[ ] Refactor detection logic',
    ];
    checklist.forEach(item => console.log(`  ${item}`));
  }

  // Health check
  console.log();
  console.log('='.repeat(70));
  console.log('Architecture Health Check');
  console.log('='.repeat(70) + '\n');

  const check = store.runHealthCheck();
  console.log(`Health: ${check.health.health.toUpperCase()}`);
  console.log(`Risk Level: ${check.summary.critical ? '🚨 CRITICAL' : check.summary.atRisk ? '⚠️ AT RISK' : '✅ HEALTHY'}`);
  console.log(`Requires Action: ${check.requiresAction ? 'YES' : 'No'}`);

  // Summary
  console.log();
  console.log('='.repeat(70));
  console.log('Demo Complete');
  console.log('='.repeat(70) + '\n');

  console.log('Key Capabilities Demonstrated:');
  console.log('  ✅ Pattern detection (HARDCODED_CONFIG_ENTRY)');
  console.log('  ✅ ADR generation (ADR-XXX: Adopt Provider Pattern)');
  console.log('  ✅ Architecture change queue management');
  console.log('  ✅ Refactoring guidance with before/after examples');
  console.log('  ✅ Implementation plan with step-by-step instructions');
  console.log('  ✅ Effort estimation (4 hours)');
  console.log('  ✅ Zero LLM calls - all template-based');
  console.log();
}

// ─── Run Demo ───────────────────────────────────────────────────────────────

runDemo().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
