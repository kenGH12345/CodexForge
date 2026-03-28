# Execution Log Validation Report

Generated: 2026/3/25 17:22:58

## Summary

| Metric | Value |
|--------|-------|
| Status | ❌ failed |
| Overall Score | 0/100 |
| Completed Stages | 0/5 |
| Failed Stages | 5 |
| Warnings | 0 |

## Stage Validations

### ANALYSE

- **Status**: ❌ failed
- **Score**: 0/100
- **Errors**:
  - ❌ Missing required artifact: requirement.md
- **Checks**:

  | Check | Status | Points |
  |-------|--------|--------|
  | required_artifact_exists | ❌ | 0 |
  | optional_artifact_exists | ❌ | 0 |

### ARCHITECT

- **Status**: ❌ failed
- **Score**: 0/100
- **Errors**:
  - ❌ Missing required artifact: architecture.md
- **Checks**:

  | Check | Status | Points |
  |-------|--------|--------|
  | required_artifact_exists | ❌ | 0 |
  | optional_artifact_exists | ❌ | 0 |

### PLAN

- **Status**: ❌ failed
- **Score**: 0/100
- **Errors**:
  - ❌ Missing required artifact: execution-plan.md
- **Checks**:

  | Check | Status | Points |
  |-------|--------|--------|
  | required_artifact_exists | ❌ | 0 |
  | optional_artifact_exists | ❌ | 0 |

### CODE

- **Status**: ❌ failed
- **Score**: 0/100
- **Errors**:
  - ❌ Missing required artifact: code.diff
- **Checks**:

  | Check | Status | Points |
  |-------|--------|--------|
  | required_artifact_exists | ❌ | 0 |

### TEST

- **Status**: ❌ failed
- **Score**: 0/100
- **Errors**:
  - ❌ Missing required artifact: test-report.md
- **Checks**:

  | Check | Status | Points |
  |-------|--------|--------|
  | required_artifact_exists | ❌ | 0 |
  | optional_artifact_exists | ❌ | 0 |

## Flow Validation

- **Status**: ✅ passed

## Integrity Checks

| Check | Status | Score |
|-------|--------|-------|
| all_required_artifacts_present | ❌ | N/A |
| content_completeness | ❌ | 0% |
| metadata_quality | ❌ | 0% |

## Recommendations

### 🔴 [HIGH] stage_failure
- **Message**: Stage ANALYSE validation failed
- **Action**: Re-run ANALYSE stage to generate missing artifacts
- **Stage**: ANALYSE

### 🔴 [HIGH] stage_failure
- **Message**: Stage ARCHITECT validation failed
- **Action**: Re-run ARCHITECT stage to generate missing artifacts
- **Stage**: ARCHITECT

### 🔴 [HIGH] stage_failure
- **Message**: Stage PLAN validation failed
- **Action**: Re-run PLAN stage to generate missing artifacts
- **Stage**: PLAN

### 🔴 [HIGH] stage_failure
- **Message**: Stage CODE validation failed
- **Action**: Re-run CODE stage to generate missing artifacts
- **Stage**: CODE

### 🔴 [HIGH] stage_failure
- **Message**: Stage TEST validation failed
- **Action**: Re-run TEST stage to generate missing artifacts
- **Stage**: TEST

### 🟡 [MEDIUM] low_quality
- **Message**: Overall execution score (0) below threshold
- **Action**: Review output completeness and structure
