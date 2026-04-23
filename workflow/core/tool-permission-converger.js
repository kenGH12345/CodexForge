'use strict';

const POLICY_VERSION = 'v1.0.0';

const DEFAULT_RULES = [
  {
    id: 'rm-rf-root',
    name: 'Delete Root Directory',
    patterns: [/(rm\s+-rf?\s+\/[^\s]*root)/i, /(rimraf\s+['"]?\/)|(\bremove\s+.*\/$)/i],
    severity: 'fatal',
    blocking: true,
    description: 'Attempting to recursively delete root or critical directories',
  },
  {
    id: 'rm-git-dir',
    name: 'Delete Git Directory',
    patterns: [/(rm\s+.*\.git)/i, /(rimraf\s+.*\.git)/i, /(remove.*\.git)/i],
    severity: 'critical',
    blocking: true,
    description: 'Attempting to delete .git directory',
  },
  {
    id: 'rm-node-modules-mass',
    name: 'Mass Delete Node Modules',
    patterns: [/(rm\s+-rf?\s+.*node_modules)/i, /(rimraf\s+.*node_modules)/i],
    severity: 'warning',
    blocking: false,
    description: 'Large-scale deletion of node_modules detected',
  },
  {
    id: 'hardcoded-secret',
    name: 'Hardcoded Secret',
    patterns: [
      /(password|passwd|pwd)\s*=\s*['"][^'"]{4,}['"]/i,
      /(api[_-]?key|apikey)\s*=\s*['"][^'"]{8,}['"]/i,
      /(secret[_-]?key|secretkey)\s*=\s*['"][^'"]{8,}['"]/i,
      /(auth[_-]?token|authtoken)\s*=\s*['"][^'"]{8,}['"]/i,
      /(private[_-]?key|privatekey)\s*=\s*['"][^'"]{8,}['"]/i,
    ],
    severity: 'critical',
    blocking: true,
    description: 'Potential hardcoded credential detected',
  },
  {
    id: 'eval-usage',
    name: 'Dangerous eval() Usage',
    patterns: [/(eval\s*\()/i, /(new\s+Function\s*\()/i],
    severity: 'warning',
    blocking: false,
    description: 'eval()/Function constructor detected',
  },
  {
    id: 'chmod-system',
    name: 'System File Permission Change',
    patterns: [/(chmod\s+.*\/etc)/i, /(chmod\s+.*\/usr)/i, /(chmod\s+.*\/bin)/i],
    severity: 'critical',
    blocking: true,
    description: 'Attempting to change permissions on system directories',
  },
  {
    id: 'drop-database',
    name: 'Database Drop Command',
    patterns: [/(DROP\s+DATABASE)/i, /(DROP\s+TABLE.*IF\s+EXISTS)/i],
    severity: 'critical',
    blocking: true,
    description: 'Destructive database operation detected',
  },
  {
    id: 'truncate-table',
    name: 'Table Truncate',
    patterns: [/(TRUNCATE\s+TABLE)/i],
    severity: 'warning',
    blocking: false,
    description: 'Table truncation detected',
  },
  {
    id: 'shell-injection',
    name: 'Potential Shell Injection',
    patterns: [/(exec\s*\([^)]*\$\{)/i, /(spawn\s*\([^)]*\+\s*['"])/i],
    severity: 'critical',
    blocking: true,
    description: 'Potential shell injection pattern detected',
  },
];

const SEVERITY_SCORE = {
  fatal: 45,
  critical: 30,
  warning: 12,
  info: 5,
};

function evaluateToolPermission({ toolName = 'unknown', args = [], metadata = {}, mode = 'node', extraContext = {} } = {}) {
  const searchable = buildSearchableText(args);
  const violations = [];

  for (const rule of DEFAULT_RULES) {
    for (const pattern of rule.patterns) {
      const matched = searchable.match(pattern);
      if (!matched) continue;

      violations.push({
        id: rule.id,
        name: rule.name,
        severity: rule.severity,
        blocking: rule.blocking,
        description: rule.description,
        matched: String(matched[0] || '').slice(0, 160),
      });
      break;
    }
  }

  const blockingViolations = violations.filter(v => v.blocking);
  const warnings = violations.filter(v => !v.blocking);
  const riskScore = Math.min(100, violations.reduce((sum, v) => sum + (SEVERITY_SCORE[v.severity] || 10), 0));
  const allow = blockingViolations.length === 0;
  const confidence = Number(Math.max(0.05, Math.min(0.99, 1 - riskScore / 120)).toFixed(2));
  if (!allow) {
    // visible audit trail when tool execution is denied; otherwise silent failure confuses operators
    console.error(`[tool-permission] DENY tool=${toolName} rules=[${blockingViolations.map(v => v.id).join(',')}] risk=${riskScore}`);
  }

  return {
    allow,
    decision: allow ? 'ALLOW' : 'DENY',
    policyVersion: POLICY_VERSION,
    riskScore,
    confidence,
    toolName,
    mode,
    metadata: {
      category: metadata.category || 'general',
      estimatedCost: metadata.estimatedCost || 'medium',
    },
    blockingViolations,
    warnings,
    violations,
    reason: allow
      ? (warnings.length > 0 ? `Allowed with ${warnings.length} warning(s)` : 'Allowed by policy')
      : `Denied by policy: ${blockingViolations.map(v => v.name).join(', ')}`,
    evidence: {
      timestamp: new Date().toISOString(),
      argsDigest: createArgsDigest(args),
      matchedRules: violations.map(v => v.id),
      context: {
        sessionId: extraContext.sessionId || null,
        stage: extraContext.stage || null,
      },
    },
  };
}

function buildSearchableText(args) {
  return (Array.isArray(args) ? args : [args])
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (typeof arg === 'object' && arg !== null) {
        try {
          return JSON.stringify(arg);
        } catch (_) {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(' ');
}

function createArgsDigest(args) {
  try {
    const serialized = JSON.stringify(args || []);
    return `${serialized.length}:${serialized.slice(0, 64)}`;
  } catch (_) {
    const fallback = String(args || '');
    return `${fallback.length}:${fallback.slice(0, 64)}`;
  }
}

module.exports = {
  POLICY_VERSION,
  DEFAULT_RULES,
  evaluateToolPermission,
};