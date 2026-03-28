/**
 * /benchmark Command — WorkflowAgent vs AI IDE 对比评估命令
 *
 * Purpose: 执行并分析 WorkflowAgent 与原生 IDE 的质量对比
 *
 * Usage:
 *   /benchmark                          # Run full benchmark
 *   /benchmark --level=complex          # Run specific level only
 *   /benchmark --tasks=simple-001,medium-002  # Run specific tasks
 *   /benchmark --report                 # Generate report from existing results
 *   /benchmark --list                   # List available tasks
 *
 * ADR-37 Compliance: Uses IDE-native modules only
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { BenchmarkRunner } = require('../core/benchmark-runner');
const { TaskBankLoader } = require('../core/benchmark-runner');
const { BenchmarkReportGenerator } = require('../core/benchmark-report-generator');

// ═══════════════════════════════════════════════════════════════════════════
// Section 1: Command Handler
// ═══════════════════════════════════════════════════════════════════════════

async function executeBenchmark(args = {}) {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('           WorkflowAgent vs AI IDE Benchmark Tool');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // Parse arguments
  const options = parseArgs(args);

  // Handle subcommands
  if (options.list) {
    return listTasks();
  }

  if (options.report) {
    return generateReportOnly();
  }

  // Run benchmark
  return runBenchmark(options);
}

function parseArgs(args) {
  const options = {
    list: false,
    report: false,
    level: null,
    tasks: null,
    outputDir: './benchmarks/results',
    verbose: false,
  };

  // Parse string arguments
  if (typeof args === 'string') {
    const parts = args.split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      
      if (part === '--list') {
        options.list = true;
      } else if (part === '--report') {
        options.report = true;
      } else if (part === '--verbose' || part === '-v') {
        options.verbose = true;
      } else if (part.startsWith('--level=')) {
        options.level = part.split('=')[1];
      } else if (part.startsWith('--tasks=')) {
        options.tasks = part.split('=')[1].split(',');
      } else if (part.startsWith('--output=')) {
        options.outputDir = part.split('=')[1];
      }
    }
  }

  // Parse object arguments
  if (typeof args === 'object' && args !== null) {
    Object.assign(options, args);
  }

  return options;
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 2: Subcommands
// ═══════════════════════════════════════════════════════════════════════════

function listTasks() {
  console.log('[Benchmark] Available Tasks\n');
  
  const loader = new TaskBankLoader();
  const tasks = loader.loadAllTasks();
  
  const tasksByLevel = {};
  for (const task of tasks) {
    if (!tasksByLevel[task.level]) tasksByLevel[task.level] = [];
    tasksByLevel[task.level].push(task);
  }
  
  const levelOrder = ['simple', 'medium', 'complex', 'production'];
  const levelIcons = { simple: '🟢', medium: '🟡', complex: '🔴', production: '🔷' };
  
  for (const level of levelOrder) {
    const levelTasks = tasksByLevel[level] || [];
    if (levelTasks.length === 0) continue;
    
    console.log(`${levelIcons[level]} ${level.toUpperCase()} (${levelTasks.length} tasks)`);
    console.log('─'.repeat(60));
    
    for (const task of levelTasks) {
      console.log(`  ${task.id.padEnd(12)} │ ${task.name}`);
      console.log(`              │ └─ ${task.description.substring(0, 60)}...`);
      console.log();
    }
  }
  
  console.log(`\nTotal: ${tasks.length} tasks available\n`);
  console.log('Run specific tasks:');
  console.log('  /benchmark --tasks=simple-001,simple-002');
  console.log('  /benchmark --level=complex');
  console.log('  /benchmark --list')
}

async function generateReportOnly() {
  console.log('[Benchmark] Generating report from existing results...\n');
  
  const latestReportPath = path.join(
    __dirname, 
    '../../benchmarks/results/latest-benchmark-report.json'
  );
  
  if (!fs.existsSync(latestReportPath)) {
    console.error('❌ No benchmark results found. Run /benchmark first.');
    return { success: false, error: 'No results found' };
  }
  
  const report = JSON.parse(fs.readFileSync(latestReportPath, 'utf-8'));
  
  const generator = new BenchmarkReportGenerator();
  const outputPaths = generator.generate(report);
  
  console.log('\n✅ Report generated:');
  console.log(`   Markdown: ${outputPaths.markdown}`);
  console.log(`   HTML: ${outputPaths.html}`);
  
  return { success: true, paths: outputPaths };
}

async function runBenchmark(options) {
  console.log('[Benchmark] Configuration:');
  console.log(`  Tasks: ${options.tasks ? options.tasks.join(', ') : options.level || 'ALL'}`);
  console.log(`  Output: ${options.outputDir}`);
  console.log(`  Verbose: ${options.verbose ? 'Yes' : 'No'}`);
  console.log('');

  // Initialize runner
  const runner = new BenchmarkRunner({
    outputDir: options.outputDir,
    verbose: options.verbose,
  });

  // Prepare filter
  const filter = options.tasks ? options.tasks : 
                 options.level ? { level: options.level } : 
                 null;

  // Run benchmark
  const startTime = Date.now();
  
  try {
    const report = await runner.runBenchmark({ taskFilter: filter });
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                Benchmark Complete');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
    
    // Print summary
    const { summary } = report;
    console.log('📊 Summary:');
    console.log(`   Total Tasks: ${summary.totalTasks}`);
    console.log(`   WorkflowAgent Wins: ${summary.workflowAgentWins} (${((summary.workflowAgentWins / summary.totalTasks) * 100).toFixed(0)}%)`);
    console.log(`   IDE Wins: ${summary.ideWins} (${((summary.ideWins / summary.totalTasks) * 100).toFixed(0)}%)`);
    console.log(`   Ties: ${summary.ties} (${((summary.ties / summary.totalTasks) * 100).toFixed(0)}%)`);
    console.log('');
    console.log(`📈 Average Scores:`);
    console.log(`   WorkflowAgent: ${summary.avgWorkflowAgentScore.toFixed(1)}/100`);
    console.log(`   IDE: ${summary.avgIdeScore.toFixed(1)}/100`);
    console.log(`   Delta: ${summary.avgScoreDelta > 0 ? '+' : ''}${summary.avgScoreDelta.toFixed(1)}`);
    console.log('');
    
    // Identify winner
    if (summary.avgScoreDelta > 5) {
      console.log('🏆 Winner: WorkflowAgent');
    } else if (summary.avgScoreDelta < -5) {
      console.log('💻 Winner: Native IDE');
    } else {
      console.log('🤝 Result: Statistically equivalent');
    }
    
    // Generate detailed report
    console.log('');
    console.log('[Benchmark] Generating detailed reports...');
    
    const generator = new BenchmarkReportGenerator({ outputDir: options.outputDir });
    const outputPaths = generator.generate(report);
    
    console.log('');
    console.log('✅ Reports generated:');
    console.log(`   Markdown: ${outputPaths.markdown}`);
    console.log(`   HTML: ${outputPaths.html}`);
    console.log(`   JSON: benchmarks/results/latest-benchmark-report.json`);
    
    console.log('');
    console.log(`⏱️  Total time: ${elapsed}s`);
    console.log('');
    
    return {
      success: true,
      report,
      paths: outputPaths,
      elapsed,
    };
    
  } catch (error) {
    console.error('❌ Benchmark failed:', error.message);
    if (options.verbose) {
      console.error(error.stack);
    }
    return { success: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Section 3: Command Registration
// ═══════════════════════════════════════════════════════════════════════════

const benchmarkCommand = {
  name: 'benchmark',
  description: 'Run WorkflowAgent vs AI IDE comparison benchmark',
  usage: '/benchmark [options]',
  examples: [
    '/benchmark',
    '/benchmark --level=simple',
    '/benchmark --tasks=simple-001,medium-002',
    '/benchmark --list',
    '/benchmark --report',
  ],
  options: {
    '--list': 'List all available benchmark tasks',
    '--report': 'Generate report from existing results',
    '--level=<level>': 'Run only tasks of specific level (simple/medium/complex/production)',
    '--tasks=<ids>': 'Run specific tasks by ID (comma-separated)',
    '--output=<dir>': 'Output directory for results (default: ./benchmarks/results)',
    '--verbose': 'Enable verbose output',
  },
  handler: executeBenchmark,
};

module.exports = {
  benchmarkCommand,
  executeBenchmark,
};

// CLI execution
if (require.main === module) {
  const args = process.argv.slice(2).join(' ');
  executeBenchmark(args).then(result => {
    process.exit(result.success ? 0 : 1);
  });
}
