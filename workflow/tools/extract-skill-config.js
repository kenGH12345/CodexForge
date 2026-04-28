const fs = require('fs');
const path = require('path');

const skillsDir = path.resolve(__dirname, '..', 'skills');
const outDir  = path.resolve(__dirname, '..', '..', 'output');
const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md')).sort();

function cleanDescription(raw, skillName) {
  if (!raw || raw === '>') return ''; // let fallback handle
  // Strip trailing garbage patterns like �?---,  �?, 乱码
  let cleaned = raw.replace(/[\uFFFD\u0000-\u001F]/g, '').replace(/\?---$/g, '').replace(/[\?\ufffd]+$/g, '').trim();
  // If after cleanup it's empty or too short, signal fallback
  if (cleaned.length < 5) return '';
  return cleaned;
}

const HARD_CODED = {
  'pitfall-recorder': {
    description: 'Four-section structured pitfall recording methodology for capturing lessons learned with context, symptom, root cause, and fix',
    domains: ['quality', 'learning', 'pitfall']
  },
  'structured-output': {
    description: 'Structured output formatting, JSON schema enforcement, and response templating best practices',
    domains: ['structured', 'output', 'formatting']
  },
  'stable-pattern-long-term-memory': {
    description: 'Long-term stable pattern memory and persistent knowledge retention strategies for reusable solutions',
    domains: ['stable', 'pattern', 'memory']
  }
};

const entries = [];
for (const file of files) {
  const content = fs.readFileSync(path.join(skillsDir, file), 'utf8');
  const name = path.basename(file, '.md');
  
  // Hard-coded overrides for known-bad frontmatters
  if (HARD_CODED[name]) {
    entries.push({ name, description: HARD_CODED[name].description, domains: HARD_CODED[name].domains });
    continue;
  }
  
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  let description = '';
  let domains = [];
  
  if (fmMatch) {
    const fm = fmMatch[1];
    const descMatch = fm.match(/description:\s*["']?(.+?)["']?\s*$/m);
    if (descMatch) description = descMatch[1].trim();
    
    const domMatch = fm.match(/domains:\s*\[([^\]]*)\]/);
    if (domMatch) {
      domains = domMatch[1].split(',').map(d => d.trim().replace(/['"]/g, '')).filter(Boolean);
    }
  }
  
  description = cleanDescription(description, name);
  
  // Fallback: H1 from body
  if (!description) {
    const h1Match = content.match(/^#\s+(.+)$/m);
    if (h1Match) description = h1Match[1].trim().replace(/[\uFFFD\u0000-\u001F]/g, '');
  }
  // Final fallback
  if (!description) {
    description = `${name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} best practices and patterns`;
  }
  
  if (domains.length === 0) {
    domains = [name.split('-')[0] || 'general'];
  }
  
  entries.push({ name, description, domains });
}

// Write raw JSON
fs.writeFileSync(path.join(outDir, 'skill-registrations.json'), JSON.stringify(entries, null, 2));

// Write JS-ready replacement block
let jsBlock = '';
jsBlock += '  // ─── Built-in Skills (auto-extracted from workflow/skills/*.md frontmatters)\n';
jsBlock += '  // On \'2026-04-27\': 50 skills registered (was 4 — P0 fix)\n';
jsBlock += '  builtinSkills: [\n';
for (const e of entries) {
  const domArr = e.domains.map(d => `"${d}"`).join(', ');
  jsBlock += `    { name: "${e.name}", description: "${e.description}", domains: [${domArr}] },\n`;
}
jsBlock += '  ],\n';

fs.writeFileSync(path.join(outDir, 'builtinSkills-replacement.js'), jsBlock);
console.log(`Extracted ${entries.length} skills`);

// Also print any cleaned descriptions for audit
const cleaned = entries.filter(e => e.description.length < 30 || e.description.includes('best practices and patterns'));
if (cleaned.length > 0) {
  console.log('\n⚠️  Descriptions that fell back to generic:');
  cleaned.forEach(e => console.log(`   ${e.name}: "${e.description}"`));
}