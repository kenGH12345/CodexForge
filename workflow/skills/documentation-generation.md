---
name: documentation-generation
version: 1.0.0
type: domain-skill
domains: [documentation, writing, api-docs, changelog]
dependencies: [structured-output]
load_level: task
max_tokens: 1200
triggers:
  keywords: [document, documentation, doc, readme, changelog, api doc, jsdoc, javadoc, docstring, comment, wiki, guide, tutorial, migration guide]
  roles: [analyst, architect, developer, reviewer]
description: "Documentation generation skill covering API docs, changelogs, migration guides, README files, and inline code documentation. Ensures consistency, completeness, and audience-appropriate writing."
---

# Skill: documentation-generation

> **Type**: Domain Skill
> **Version**: 1.0.0
> **Description**: Documentation generation covering API docs, changelogs, migration guides, README files, and inline code documentation
> **Domains**: documentation, writing, api-docs, changelog

---

## Rules
<!-- PURPOSE: Prescriptive constraints that MUST be followed. Written as imperatives ("Always X", "Never Y"). Each rule should be independently verifiable. -->

### R1: Audience-First Writing (MANDATORY)
- **Always** identify the target audience BEFORE writing: developer (API consumer), operator (deployment), end-user (feature), or contributor (internal).
- **Never** mix audience levels in a single document section. API reference is for developers; deployment guide is for operators.
- Use the **inverted pyramid**: most important information first, details later.

### R2: Code-Documentation Consistency (MANDATORY)
- Every public function/method/class MUST have a doc comment (JSDoc, Javadoc, docstring, etc.).
- Doc comments MUST match the actual function signature — parameter names, types, return types.
- When code changes, the corresponding documentation MUST be updated in the same commit.
- **Never** document implementation details that may change — document the contract (what), not the mechanism (how).

### R3: Changelog Discipline
- Every user-facing change MUST have a changelog entry.
- Format: `[ADDED|CHANGED|DEPRECATED|REMOVED|FIXED|SECURITY] - Description (issue/PR reference)`.
- Changelog entries are written for the **user**, not the developer. "Fixed null pointer in UserService.java" → "Fixed crash when loading user profile with empty avatar".

### R4: No Stale Documentation
- Documentation without a "last updated" date or version reference is considered stale.
- README files MUST include: project description, quick start, prerequisites, and contribution guide.
- API documentation MUST include: endpoint, method, parameters, response format, error codes, and at least one example.

## SOP (Standard Operating Procedure)
<!-- PURPOSE: Step-by-step workflow for documentation generation. -->

### Phase 1: Audit Existing Documentation
1. Scan the project for existing docs: README, CHANGELOG, docs/, wiki/, inline comments.
2. Identify gaps: undocumented public APIs, missing README sections, outdated guides.
3. Classify each gap by audience and priority.

### Phase 2: Generate Documentation
1. **API Documentation**: Extract from code signatures + JSDoc/Javadoc/docstring. Include:
   - Function signature with types
   - Parameter descriptions (name, type, required/optional, default value)
   - Return value description
   - Thrown exceptions/errors
   - Usage example (at least one)
2. **README**: Follow the standard template:
   - Project name + one-line description
   - Badges (build status, coverage, version)
   - Quick Start (3-5 steps to get running)
   - Prerequisites
   - Installation
   - Usage examples
   - Configuration
   - Contributing guide
   - License
3. **Changelog**: Follow Keep a Changelog format (https://keepachangelog.com/).
4. **Migration Guide**: For breaking changes, provide:
   - What changed (before → after)
   - Why it changed
   - Step-by-step migration instructions
   - Automated migration script (if applicable)

### Phase 3: Review and Validate
1. Cross-reference documentation against actual code — every documented API must exist.
2. Run code examples to verify they work.
3. Check for broken links.
4. Verify terminology consistency across all documents.

## Checklist
<!-- PURPOSE: Verification checklist to run AFTER completing documentation work. -->

- [ ] Every public API has a doc comment with parameters, return type, and example
- [ ] README has all required sections (description, quick start, prerequisites, install, usage, config, contributing, license)
- [ ] CHANGELOG follows Keep a Changelog format with audience-appropriate descriptions
- [ ] No broken internal links or references to non-existent files
- [ ] Code examples in documentation are tested and working
- [ ] Documentation language matches the project's primary language
- [ ] Version numbers in documentation match the actual release version
- [ ] Migration guide exists for every breaking change

## Best Practices
<!-- PURPOSE: Recommended patterns that SHOULD be followed. -->

### BP1: Progressive Disclosure in Documentation
- Start with the simplest use case (happy path).
- Add complexity gradually: configuration options, advanced usage, edge cases.
- Use collapsible sections (`<details>`) for advanced content that most readers don't need.

### BP2: Example-Driven Documentation
- Every API endpoint or function should have at least one copy-paste-ready example.
- Examples should use realistic data, not `foo`/`bar`/`test123`.
- Include both success and error response examples for APIs.

### BP3: Documentation as Code
- Store documentation in the same repository as code (docs-as-code).
- Use Markdown for portability and version control friendliness.
- Automate documentation generation where possible (TypeDoc, Swagger, Sphinx).
- Include documentation checks in CI/CD pipeline.

### BP4: Diagram-First for Architecture
- Use Mermaid or PlantUML for architecture diagrams (version-controllable).
- Every system with 3+ components should have a component diagram.
- Data flow diagrams for any process involving 2+ services.

## Anti-Patterns
<!-- PURPOSE: Common MISTAKES to avoid. -->

| ❌ Anti-Pattern | ✅ Correct Approach |
|----------------|---------------------|
| Writing docs after the project is "done" | Write docs alongside code, in the same PR |
| Documenting every private method | Document public API contracts only; private methods are implementation details |
| Copy-pasting code into docs without testing | Use tested code snippets or doc-test frameworks |
| "See code for details" as documentation | Provide at least a one-sentence summary of what the code does and why |
| Monolithic README with everything | Split into focused files: README (overview), CONTRIBUTING, API.md, ARCHITECTURE.md |
| Screenshots without alt text | Always include alt text and text descriptions for accessibility |

## Gotchas
<!-- PURPOSE: Environment/version/platform-SPECIFIC traps. -->

- **JSDoc + TypeScript**: JSDoc `@param` types are ignored when TypeScript types are present. Use TypeScript types as the source of truth; JSDoc adds descriptions only.
- **Markdown rendering differences**: GitHub Flavored Markdown (GFM) supports `<details>`, Mermaid, and task lists. Standard Markdown does not. Always test rendering on the target platform.
- **Auto-generated docs staleness**: Tools like Swagger/OpenAPI generate docs from code annotations. If annotations are outdated, generated docs will be wrong. Treat annotations as first-class code.

## Context Hints
<!-- PURPOSE: Background knowledge for better decisions. -->

- The Keep a Changelog format (https://keepachangelog.com/) is the de facto standard for changelogs.
- Semantic Versioning (https://semver.org/) should be referenced in all version-related documentation.
- For API documentation, the OpenAPI 3.0+ specification is the industry standard for REST APIs.
- Diátaxis framework (https://diataxis.fr/) categorizes documentation into 4 types: tutorials, how-to guides, reference, explanation. Each serves a different purpose.

## Code Snippets
<!-- PURPOSE: Reusable documentation templates. -->

### JSDoc Function Template
```javascript
/**
 * Brief description of what this function does.
 *
 * @param {string} name - Description of the parameter
 * @param {object} [options] - Optional configuration
 * @param {number} [options.timeout=3000] - Timeout in milliseconds
 * @returns {Promise<Result>} Description of the return value
 * @throws {ValidationError} When name is empty
 * @example
 * const result = await myFunction('test', { timeout: 5000 });
 * console.log(result.status); // 'ok'
 */
```

### Changelog Entry Template
```markdown
## [1.2.0] - 2026-04-10

### Added
- New `/api/users/search` endpoint for full-text user search (#123)

### Changed
- Improved error messages for authentication failures (#456)

### Fixed
- Fixed memory leak in WebSocket connection handler (#789)
```

## Evolution History

| Version | Date | Change |
|---------|------|--------|
| v1.0.0 | 2026-04-10 | Initial creation — fills Documentation Skills gap (Anthropic 9-category coverage) |

---

<!-- KNOWLEDGE_SOURCES -->
<!--
  This skill can be auto-enriched with knowledge from:

  1. AgentHub Knowledge Base (UUID: 86d363ab81634904b1cbc1b46acc66bc)
     - Use MCP tool: knowledge.knowledgebase_search
     - Query: "documentation generation best practices patterns"
     - Domains: documentation, writing, api-docs

  2. Web Search + LLM Analysis
     - Automatically triggered via enrichSkillFromExternalKnowledge()
     - When WebSearch MCP adapter is available

  To manually enrich this skill, run:
  > /wf enrich-skill documentation-generation
-->
