/**
 * Phase 3 Demo: Code Generator
 *
 * Demonstrates automatic code generation from ADR proposals,
 * AST-based transformation, and safe refactoring.
 *
 * Scenario: ADR generated in Phase 2 now triggers actual code generation.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ExperienceStore } = require('../core/experience-store');
const { ExperienceType, ExperienceCategory } = require('../core/experience-types');

// ─── Demo Configuration ─────────────────────────────────────────────────────

const DEMO_OUTPUT_DIR = path.join(__dirname, '../../output/demo-phase3');

// ─── Helper Functions ───────────────────────────────────────────────────────

function createHardcodedExperience(ideName, daysAgo) {
  return {
    type: ExperienceType.NEGATIVE,
    category: ExperienceCategory.CONFIG_SYSTEM,
    title: `Fix: Add ${ideName} IDE detection`,
    content: `Added ${ideName} to IDE_SIGNATURES. This is becoming unmaintainable.`,
    createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    tags: ['ide', 'hardcoded', 'config'],
  };
}

// ─── Demo Scenarios ─────────────────────────────────────────────────────────

async function runDemo() {
  console.log('\n' + '='.repeat(70));
  console.log('  Phase 3 Demo: Code Generator');
  console.log('  From ADR Proposal → Production Code');
  console.log('='.repeat(70) + '\n');

  // Initialize experience store
  const store = new ExperienceStore(path.join(DEMO_OUTPUT_DIR, 'experiences.json'));

  console.log('Step 1: Simulate 5 hardcoded IDE fixes (triggering pattern detection)\n');

  const ideFixes = ['Trae', 'Zed', 'KimiCode', 'PearAI', 'VoidEditor'];
  ideFixes.forEach((name, idx) => {
    const exp = createHardcodedExperience(name, 56 - idx * 14);
    store.recordWithAbstraction(exp);
    console.log(`  ${idx + 1}. Recorded: Fix for ${name}`);
  });

  console.log('\nStep 2: Run full analysis (Phase 1 + Phase 2 + Phase 3 integration)\n');

  const analysis = store.analyzeAbstractions();

  console.log(`  📊 Patterns triggered: ${analysis.detection.triggeredPatterns.length}`);
  console.log(`  📄 ADR proposals generated: ${analysis.adrProposals?.length || 0}`);

  if (!analysis.adrProposals?.length) {
    console.log('\n  No patterns triggered. Skipping code generation demo.');
    return;
  }

  const adrs = analysis.adrProposals;

  // Step 3: Preview code generation
  console.log('\n' + '='.repeat(70));
  console.log('Step 3: Preview Code Generation (Dry Run)');
  console.log('='.repeat(70) + '\n');

  for (const { adr } of adrs) {
    console.log(`📄 ${adr.id}: ${adr.title}`);
    console.log(`   Pattern: ${adr.metadata.patternName}`);
    console.log();

    const preview = store.previewCodeRefactoring(adr.id);

    if (preview?.files?.length) {
      console.log('   Files to be generated:');
      preview.files.forEach(f => {
        console.log(`     📁 ${path.basename(f.path)}`);
        if (f.content) {
          const lines = f.content.split('\n').length;
          console.log(`        ${lines} lines`);
        }
      });
    } else {
      console.log('   ⚠️ No code generation preview available');
    }
    console.log();
  }

  // Step 4: Generate code (dry run - safe mode)
  console.log('='.repeat(70));
  console.log('Step 4: Execute Code Generation (Dry Run = Safe Mode)');
  console.log('='.repeat(70) + '\n');

  for (const { adr } of adrs) {
    console.log(`🚀 Generating code for ${adr.id}...\n`);

    const result = store.generateCodeFromADR(adr.id, { dryRun: true });

    if (result?.operations) {
      result.operations.forEach(op => {
        if (op.type === 'generate' && op.results) {
          console.log('   Generated files:');
          op.results.forEach(r => {
            const status = r.success ? '✅' : '❌';
            const filepath = r.filePath || r.previewPath;
            console.log(`   ${status} ${path.basename(filepath)}`);
          });
        }
      });
    }
    console.log();
  }

  // Step 5: Direct Provider Pattern generation
  console.log('='.repeat(70));
  console.log('Step 5: Direct Provider Pattern Generation');
  console.log('='.repeat(70) + '\n');

  const generated = store.generateProviderPattern({
    adrId: adrs[0]?.adr?.id || 'DEMO',
    domain: 'ide',
  });

  console.log('\n   Checking generated code quality:\n');

  generated.forEach((result, idx) => {
    if (result.success && result.content) {
      console.log(`   📄 File ${idx + 1}: ${path.basename(result.filePath || 'preview')}`);
      console.log(`      Lines: ${result.content.split('\n').length}`);
      console.log(`      Has JSDoc: ${result.content.includes('/**') ? '✅' : '❌'}`);
      console.log(`      Has exports: ${result.content.includes('module.exports') ? '✅' : '❌'}`);

      // Check specific features
      if (result.content.includes('class ProviderRegistry')) {
        console.log(`      Class methods: ${(result.content.match(/\w+\(/g) || []).slice(0, 5).join(', ')}...`);
      }
      console.log();
    }
  });

  // Step 6: Show refactoring audit log
  console.log('='.repeat(70));
  console.log('Step 6: Refactoring Audit Log');
  console.log('='.repeat(70) + '\n');

  const auditLog = store.getRefactoringLog();
  console.log(`   Total operations logged: ${auditLog.length}\n`);

  if (auditLog.length > 0) {
    auditLog.forEach((entry, idx) => {
      console.log(`   ${idx + 1}. ${entry.action.toUpperCase()} - ${entry.adrId}`);
      console.log(`      Timestamp: ${entry.timestamp}`);
    });
  }

  // Step 7: Summary
  console.log();
  console.log('='.repeat(70));
  console.log('Demo Summary');
  console.log('='.repeat(70) + '\n');

  console.log('📦 Files Generated:');
  generated.forEach(r => {
    if (r.success) {
      console.log(`   - ${path.basename(r.filePath || 'preview')}`);
    }
  });

  console.log('\n🔧 Key Capabilities Demonstrated:');
  console.log('  ✅ ADR → Code workflow');
  console.log('  ✅ Template-based code generation');
  console.log('  ✅ Provider Pattern implementation');
  console.log('  ✅ Dry-run mode (safe preview)');
  console.log('  ✅ Production-ready JSDoc comments');
  console.log('  ✅ Audit logging for compliance');
  console.log('  ✅ Zero LLM calls for code generation');

  console.log('\n⚡ Safety Features:');
  console.log('  - All operations run in dry-run mode by default');
  console.log('  - Backup creation before any file modification');
  console.log('  - Rollback capability for all transformations');
  console.log('  - Preview mode for review before applying');

  console.log();

  // Write out sample generated files for inspection
  console.log('='.repeat(70));
  console.log('Writing sample files for inspection...');
  console.log('='.repeat(70) + '\n');

  const sampleDir = path.join(DEMO_OUTPUT_DIR, 'generated-samples');
  if (!fs.existsSync(sampleDir)) {
    fs.mkdirSync(sampleDir, { recursive: true });
  }

  generated.forEach((result, idx) => {
    if (result.success && result.content) {
      const filename = path.basename(result.filePath || `sample-${idx}.js`);
      const filepath = path.join(sampleDir, filename);
      fs.writeFileSync(filepath, result.content, 'utf-8');
      console.log(`  ✅ Written: ${filepath}`);
    }
  });

  console.log();
  console.log('📂 Sample files location:');
  console.log(`   ${sampleDir}`);

  // Show a code sample
  console.log();
  console.log('='.repeat(70));
  console.log('Sample: Generated ProviderRegistry Class');
  console.log('='.repeat(70) + '\n');

  const registryResult = generated.find(r =>
    (r.filePath || r.previewPath || '').includes('provider-registry')
  );

  if (registryResult?.content) {
    const lines = registryResult.content.split('\n');
    console.log('```javascript');
    lines.slice(0, 60).forEach(line => {
      console.log(line);
    });
    console.log('...');
    console.log(`${lines.length - 60} more lines`);
    console.log('```');
  }

  console.log();
  console.log('='.repeat(70));
  console.log('Phase 3 Demo Complete');
  console.log('='.repeat(70) + '\n');

  console.log('Next Steps:');
  console.log('  1. Review generated code in sample directory');
  console.log('  2. Run with dryRun: false to apply changes');
  console.log('  3. Integrate with CI/CD pipeline');
  console.log('  4. Extend templates for more patterns\n');
}

// ─── Run Demo ───────────────────────────────────────────────────────────────

runDemo().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});
