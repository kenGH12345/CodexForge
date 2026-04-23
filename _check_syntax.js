const { execSync } = require('child_process');
try {
  execSync('node --check workflow/tools/ide-workflow-bridge.js', { stdio: 'pipe' });
  console.log('Syntax OK');
} catch(e) {
  console.error('Syntax Error:', e.stderr ? e.stderr.toString() : e.message);
}
