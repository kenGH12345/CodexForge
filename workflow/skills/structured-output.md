---
name: structured-output
version: 1.0.0
type: domain-skill
description: >
  Standards for producing clear, non-redundant, actionable structured output.
  This skill SHOULD be activated by default for almost all text-generating tasks,
  including but not limited to: writing code comments, answering questions, generating
  documents, drafting emails, creating READMEs, explaining concepts, summarizing content,
  producing technical specs, requirements, instructions, or any multi-sentence response.
  Trigger broadly: whenever the output is more than a one-line answer, apply these rules
  to maximize information density and reduce token waste.
  Explicit triggers include "write clearly", "structure this", "organize this",
  "apply writing standards", "structured output", "reduce redundancy", "be concise",
  "简洁", "结构化", "精简", "不要啰嗦", "少说废话", or any request
  for improving text quality, clarity, or brevity.
---

# Structured Output Standards

## Goal

Maximize information density per token. Every token MUST earn its place by contributing to understanding, decision, or action. Reducing token waste directly improves Agent efficiency — fewer tokens means faster inference, lower cost, and more room in the context window for what matters.

## Conventions

- Resolve conflicts by priority: **Correctness > Actionability > Non-redundancy > Clarity**.
- Strength indicators (RFC 2119): **MUST** (mandatory), **SHOULD** (recommended), **MAY** (optional).

## Rules

### 1. Conflict Resolution

- MUST follow priority: Correctness > Actionability > Non-redundancy > Clarity.
- MUST ask for clarification when uncertain; MUST NOT assume.

### 2. Logical Ordering

- MUST organize each level by one primary order: temporal, causal, or dependency.
- If switching order type, MUST split into explicit subsections with labeled ordering.

### 3. Tree Structure

- MUST use tree-shaped outline; each sentence belongs to exactly one section.
- MUST use paragraph headings as the main idea of that section.
- MUST NOT repeat content across sections; use cross-references (e.g., "See §2").

### 4. No Redundancy

- MUST state each piece of information exactly once.
- MUST delete content that does not change understanding, decision, or action.
- Supplementary content (prerequisites, boundaries, verification, failure handling) MAY be added only if explicitly labeled.

### 5. Terminology

- SHOULD prefer domain terms when they are the shortest and most precise option.
- MUST define terms on first use, then use consistently throughout.
- MUST avoid vague qualifiers (e.g., "fast", "large") unless testable bounds are provided (e.g., "< 3s", "> 1GB").

### 6. Conciseness

- MUST prefer short sentences over long compound ones.
- MUST use lists/tables over paragraphs when conveying parallel items.
- MUST omit filler words ("basically", "actually", "in order to" → "to").
- SHOULD compress: heading as topic sentence, body as supporting evidence only.

### 7. Information Density

- MUST front-load key information: conclusion/action first, reasoning second.
- MUST use structured formats (heading > bullet > table) to reduce parsing cost.
- SHOULD merge adjacent related points into one compact statement when meaning is preserved.
- MUST NOT pad output to appear thorough; brevity with completeness is the goal.
