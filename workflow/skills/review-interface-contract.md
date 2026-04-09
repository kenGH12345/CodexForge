---
name: review-interface-contract
version: 1.0.0
type: standards
domains: [interface, contract, api, code-review]
dependencies: [api-design]
load_level: task
max_tokens: 500
triggers:
  keywords: [interface, contract, schema, api contract, type mismatch, breaking change, compatibility, export, signature]
  roles: [reviewer]
description: "Interface-contract review pack for diff risk scenarios"
---

# Skill: review-interface-contract

> **Version**: 1.0.0
> **Description**: Interface-contract review pack for diff risk scenarios

## Rules

- Every contract FAIL needs producer/consumer evidence pair.
- Breaking-change claims require explicit before/after signature delta.
- Prefer backward-compatible fix when requirement scope allows.

## Checklist

- Return object fields match caller expectations
- Function signatures and types remain compatible
- Export/re-export completeness for changed symbols
- Schema/version changes are synchronized across boundaries

## Anti-Patterns

- Declaring "breaking change" without caller usage evidence
- Assuming dynamic language means no contract risk
- Ignoring barrel/index re-export drift

## Context Hints

- Validate both module boundary and call-site assumptions.
- Provide minimum patch that restores compatibility first.
