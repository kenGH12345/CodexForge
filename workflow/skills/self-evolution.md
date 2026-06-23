---
name: self-evolution
version: 1.0.0
type: workflow-skill
description: "自演化协议: MAPE分析/回归检查/Skill精炼/Article Scouting/TechRadar"
triggers:
  keywords: [mape, regression, skill-refine, article-scout, tech-radar, 自演化, 演化]
max_tokens: 800
dependencies: []
---

# Self-Evolution Protocol

**Key insight**: In IDE Agent mode, YOU are the LLM. No extra API calls needed.

## MAPE Analysis
```
node workflow/tools/ide-workflow-bridge.js mape-analysis --project-root .
```
Run after every 5-10 workflows. Parse signals for anomalies (token trends, error rates, hit-rates, gate failures). Execute HIGH/CRITICAL actions yourself.

## Regression Check
```
node workflow/tools/ide-workflow-bridge.js regression-check --project-root .
```
First run = baseline. Subsequent runs compare against baseline. If `degraded`, investigate. If `shouldRollback`, consider reverting.

## Skill Refinement
```
node workflow/tools/ide-workflow-bridge.js skill-refine-check --project-root .
```
For each candidate: **needsRefine** (deduplicate/rewrite bloated skills), **needsFix** (low hit-rate → rewrite), **stale** (>90d → web_search + update), **hollow** (placeholder → web_search + generate).

## Article Scouting
When discovering valuable patterns, record:
```
node workflow/tools/ide-workflow-bridge.js experience-record --type POSITIVE --category stable_pattern --title "[ArticleScout] <insight>" --content "<detail>" --skill "<skill>" --tags "article-scout,recommendation" --project-root .
```

## TechRadar
When finding outdated deps/APIs: web_search for current versions, record as experience with tags "tech-radar,upgrade".
