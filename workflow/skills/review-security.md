---
name: review-security
version: 1.0.0
type: standards
domains: [security, code-review]
dependencies: [security-audit]
load_level: task
max_tokens: 500
triggers:
  keywords: [security, auth, injection, xss, csrf, secret, token, credential, vulnerability]
  roles: [reviewer]
description: "Security-focused review pack for diff risk scenarios"
---

# Skill: review-security

> **Version**: 1.0.0
> **Description**: Security-focused review pack for diff risk scenarios

## Rules

- Require source→sink evidence for every injection/auth claim.
- Flag HIGH only with exploitable path in changed code.
- Secrets in code/config are immediate FAIL unless proven test fixture.

## Checklist

- Input validation and encoding on all new external inputs
- AuthN/AuthZ checks on new/changed privileged operations
- Secret/token handling (no hardcode, no unsafe logging)
- Error responses avoid leaking internals

## Anti-Patterns

- "Potential SQLi" without a concrete query/dataflow path
- Marking TODO comments as evidence of mitigation
- Security verdict based on unchanged files only

## Context Hints

- Prefer precise remediation steps: exact file/function and minimal patch scope.
- If uncertain, return N/A with rationale, not speculative FAIL.
