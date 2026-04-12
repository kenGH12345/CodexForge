---
name: review-security
version: 2.0.0
type: standards
domains: [security, code-review]
dependencies: [security-audit]
load_level: task
max_tokens: 800
triggers:
  keywords: [security, auth, injection, xss, csrf, secret, token, credential, vulnerability]
  roles: [reviewer]
description: "Security-focused review pack based on OWASP Top 10 and CWE"
---

# Skill: review-security

> **Version**: 2.0.0
> **Purpose**: Security-focused code review based on OWASP Top 10 (2021) and CWE

## Core Principle

Security findings must have **evidence**: a concrete source→sink dataflow path in the changed code. Speculative warnings waste reviewer trust.

## 1. OWASP Top 10 Review Matrix

For each diff, check against these categories (ordered by severity):

| # | Category | What to look for in diff |
|---|----------|------------------------|
| A01 | **Broken Access Control** | Missing authZ checks on new endpoints; IDOR via user-controlled IDs; path traversal in file operations; CORS misconfiguration |
| A02 | **Cryptographic Failures** | Hardcoded secrets/keys; weak hashing (MD5/SHA1 for passwords); missing TLS; sensitive data in logs/URLs |
| A03 | **Injection** | SQL/NoSQL/OS/LDAP injection via unsanitized input; template injection; header injection; eval()/exec() with user data |
| A04 | **Insecure Design** | Missing rate limiting; no abuse-case handling; trust boundary violations; missing input validation at design level |
| A05 | **Security Misconfiguration** | Debug mode in production; default credentials; unnecessary features enabled; missing security headers |
| A06 | **Vulnerable Components** | Known CVE in added dependencies; outdated packages with security patches; unvetted third-party code |
| A07 | **Auth Failures** | Weak password policy; missing brute-force protection; session fixation; JWT without expiry/signature validation |
| A08 | **Data Integrity Failures** | Deserialization of untrusted data; missing integrity checks on updates; unsigned CI/CD pipelines |
| A09 | **Logging Failures** | Sensitive data in logs; missing audit trail for security events; log injection via user input |
| A10 | **SSRF** | User-controlled URLs in server-side requests; missing allowlist for outbound connections |

## 2. Severity Classification

| Severity | Criteria | Action |
|----------|----------|--------|
| **CRITICAL** | Exploitable in production with changed code; data breach risk | Block merge. Require immediate fix. |
| **HIGH** | Exploitable path exists but requires specific conditions | Block merge. Fix before release. |
| **MEDIUM** | Defense-in-depth gap; no direct exploit path visible | Warn. Fix in next sprint. |
| **LOW** | Best practice deviation; hardening opportunity | Note. Track in backlog. |

## 3. Evidence Requirements

Every security finding MUST include:

```
[SEVERITY] Category: A0X - Name
Source: <where untrusted data enters> (file:line)
Sink:   <where it reaches dangerous operation> (file:line)
Path:   source → transform1 → transform2 → sink
Impact: <what an attacker can achieve>
Fix:    <specific remediation with code location>
```

**No evidence = no finding.** Do not flag speculative risks.

## 4. Secret Detection Rules

| Pattern | Verdict | Exception |
|---------|---------|-----------|
| API key/token in source code | CRITICAL | Test fixtures with `_test`/`_mock` prefix |
| Password in config file | CRITICAL | Encrypted/vault reference |
| Private key in repo | CRITICAL | None |
| Hardcoded URL with credentials | HIGH | Local dev config with `.local` suffix |
| `.env` file committed | HIGH | `.env.example` with placeholder values |

## Checklist (per diff)

- [ ] A01: New endpoints have authorization checks matching business rules
- [ ] A02: No secrets/keys hardcoded; sensitive data encrypted at rest/transit
- [ ] A03: All external input sanitized before use in queries/commands/templates
- [ ] A04: Rate limiting and abuse cases considered for new features
- [ ] A05: No debug flags, default creds, or unnecessary features in production config
- [ ] A06: New dependencies checked against known CVE databases
- [ ] A07: Auth flows validate tokens properly (expiry, signature, scope)
- [ ] A08: Deserialization uses allowlists; integrity checks on critical updates
- [ ] A09: Logs don't contain PII/secrets; security events are auditable
- [ ] A10: Server-side requests use URL allowlists; no user-controlled redirects

## Anti-Patterns

- "Potential SQLi" without showing the actual query and data flow path
- Flagging unchanged code as a new security issue
- Marking TODO comments as evidence of mitigation
- Suggesting "add input validation" without specifying what validation and where
- Rating everything as CRITICAL to appear thorough (severity inflation)
- Ignoring business logic flaws while focusing only on technical vulnerabilities

## Context Hints

- Prefer precise remediation: exact file, function, and minimal patch scope
- If uncertain, return N/A with rationale, not speculative FAIL
- Cross-reference with existing security controls before claiming gap
- Consider the threat model: internal tool vs public-facing API have different risk profiles
