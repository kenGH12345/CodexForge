'use strict';

const TOOL_REGISTRY = [
  {
    name: 'workflow_triage',
    handler: '_handleWorkflowTriage',
    description: 'Evaluate a requirement\'s complexity and get routing recommendation. Returns whether to use IDE directly, lightweight workflow, or full pipeline. Zero LLM cost — pure rule engine.',
    inputSchema: {
      type: 'object',
      properties: {
        requirement: {
          type: 'string',
          description: 'The requirement text to evaluate for complexity routing',
        },
      },
      required: ['requirement'],
    },
  },
  {
    name: 'workflow_run',
    handler: '_handleWorkflowRun',
    description: 'Execute the full WorkFlowAgent pipeline for a requirement. Automatically triages complexity first — if the task is too simple, returns a suggestion to handle it directly in IDE. Use --force to bypass triage.',
    inputSchema: {
      type: 'object',
      properties: {
        requirement: {
          type: 'string',
          description: 'The requirement to implement',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'sequential', 'parallel'],
          description: 'Execution mode. auto=LLM decides, sequential=full pipeline, parallel=task decomposition. Default: auto.',
        },
        force: {
          type: 'boolean',
          description: 'Skip complexity triage and force workflow execution. Default: false.',
        },
      },
      required: ['requirement'],
    },
  },
  {
    name: 'workflow_init',
    handler: '_handleWorkflowInit',
    description: 'Initialize WorkFlowAgent for a project. Detects tech stack, generates config, builds CodeGraph, creates project profile. Must run before workflow_run on new projects.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the project root directory. Defaults to the configured project root.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview what would be done without making changes. Default: false.',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_status',
    handler: '_handleWorkflowStatus',
    description: 'Get the current workflow status, including init state, staleness warnings, and active workflow progress.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'workflow_skill_discover',
    handler: '_handleSkillDiscover',
    description: 'Auto-discover project conventions from package.json, CI configs, linters, etc. Creates skill entries for tech stack specific patterns. Zero LLM cost.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to the project root directory',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_skill_evolve',
    handler: '_handleSkillEvolve',
    description: 'Trigger skill evolution for existing skills. Consolidates experience entries into skill rules. Zero LLM cost for basic evolution; LLM-Lite for refinement.',
    inputSchema: {
      type: 'object',
      properties: {
        skillName: {
          type: 'string',
          description: 'Specific skill to evolve (optional, evolves all if omitted)',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_skill_update',
    handler: '_handleSkillUpdate',
    description: 'Directly update skill content with new rules or checklists. For manual skill curation.',
    inputSchema: {
      type: 'object',
      properties: {
        skillName: {
          type: 'string',
          description: 'Name of the skill to update',
        },
        section: {
          type: 'string',
          enum: ['rules', 'best_practices', 'anti_patterns', 'checklist'],
          description: 'Section to append content to',
        },
        content: {
          type: 'string',
          description: 'Content to append to the section',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['skillName', 'section', 'content'],
    },
  },
  {
    name: 'workflow_skill_refine_check',
    handler: '_handleSkillRefineCheck',
    description: 'Identify skills that need refinement based on evolution count or staleness. Returns candidates for LLM refinement.',
    inputSchema: {
      type: 'object',
      properties: {
        threshold: {
          type: 'number',
          description: 'Evolution count threshold (default: 5)',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_experience_search',
    handler: '_handleExperienceSearch',
    description: 'Search ExperienceStore by keyword, skill, or tags. Returns relevant experiences for context injection.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword or phrase',
        },
        skill: {
          type: 'string',
          description: 'Filter by specific skill name',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10)',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'workflow_experience_context',
    handler: '_handleExperienceContext',
    description: 'Get formatted context block for a specific skill from ExperienceStore. Ready for prompt injection.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'Skill name to get context for',
        },
        limit: {
          type: 'number',
          description: 'Max experiences to include (default: 5)',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['skill'],
    },
  },
  {
    name: 'workflow_experience_record',
    handler: '_handleExperienceRecord',
    description: 'Record a new experience to ExperienceStore. Captures patterns, solutions, and outcomes for future reuse.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Experience title',
        },
        content: {
          type: 'string',
          description: 'Experience content/description',
        },
        skill: {
          type: 'string',
          description: 'Associated skill name',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization',
        },
        outcome: {
          type: 'string',
          enum: ['success', 'partial', 'failure'],
          description: 'Outcome of the experience',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['title', 'content', 'skill'],
    },
  },
  {
    name: 'workflow_experience_evolve',
    handler: '_handleExperienceEvolve',
    description: 'Trigger experience evolution: consolidation, distillation, and archival. Zero LLM cost.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview changes without applying',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_context',
    handler: '_handleContext',
    description: 'Load context (skills, ADRs, docs) for a specific workflow stage. Returns formatted context block.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          enum: ['INIT', 'ANALYSE', 'DESIGN', 'IMPLEMENT', 'TEST', 'REVIEW', 'DEPLOY'],
          description: 'Workflow stage to load context for',
        },
        task: {
          type: 'string',
          description: 'Task description for skill matching',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['stage', 'task'],
    },
  },
  {
    name: 'workflow_build_agent_prompt',
    handler: '_handleBuildAgentPrompt',
    description: 'Build role-specific agent prompt with constraints and context for a workflow stage.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          enum: ['INIT', 'ANALYSE', 'DESIGN', 'IMPLEMENT', 'TEST', 'REVIEW', 'DEPLOY'],
          description: 'Workflow stage for the agent',
        },
        task: {
          type: 'string',
          description: 'Task description',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['stage', 'task'],
    },
  },
  {
    name: 'workflow_quality_check',
    handler: '_handleQualityCheck',
    description: 'Run local QualityGate rule checks on modified or staged files. Returns violations and suggestions.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to check (uses staged files if omitted)',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_quality_gate',
    handler: '_handleQualityGate',
    description: 'Run full QualityGate threshold validation across all dimensions for current state.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          description: 'Specific stage to validate (optional)',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_quality_gate_validate_stage',
    handler: '_handleQualityGateValidateStage',
    description: 'Validate a specific workflow stage against stage-specific quality gates. P0-Enhancement for early error detection.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          enum: ['ANALYSE', 'ARCHITECT', 'PLAN', 'DEVELOP', 'TEST'],
          description: 'Stage identifier to validate',
        },
        errorCount: {
          type: 'number',
          description: 'Number of errors detected in the stage',
        },
        durationMs: {
          type: 'number',
          description: 'Stage execution duration in milliseconds',
        },
        llmCalls: {
          type: 'number',
          description: 'Number of LLM calls made during the stage',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['stage'],
    },
  },
  {
    name: 'workflow_quality_gate_diagnostics',
    handler: '_handleQualityGateDiagnostics',
    description: 'Export diagnostic history and statistics from QualityGate for analysis before switching from diagnostic to default mode.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
        clear: {
          type: 'boolean',
          description: 'Clear diagnostic history after export (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_deep_audit',
    handler: '_handleDeepAudit',
    description: 'Run DeepAuditOrchestrator across all 7 dimensions (token, complexity, dependency, etc). Zero LLM cost.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: 'Output format (default: markdown)',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_rollback_check',
    handler: '_handleRollbackCheck',
    description: 'Validate stage output against downstream Agent input contracts. Detects breaking changes.',
    inputSchema: {
      type: 'object',
      properties: {
        stage: {
          type: 'string',
          description: 'Stage to check rollback for',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: ['stage'],
    },
  },
  {
    name: 'workflow_test_execute',
    handler: '_handleTestExecute',
    description: 'Execute project tests with auto-detection of test framework. Captures results for experience recording.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Test pattern/file to run',
        },
        watch: {
          type: 'boolean',
          description: 'Watch mode (default: false)',
        },
        testProfile: {
          type: 'string',
          enum: ['fast', 'full'],
          description: 'Test profile mode (fast: smoke+unit, full: smoke+unit+integration)',
        },
        testSuites: {
          type: 'string',
          description: 'Comma-separated test suites to run (e.g. smoke,unit)',
        },
        testFiles: {
          type: 'string',
          description: 'Comma-separated file tokens for targeted rerun',
        },
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: [],
    },
  },
  {
    name: 'workflow_staleness_check',
    handler: '_handleStalenessCheck',
    description: 'Check for stale artifacts (CodeGraph, project profile) that need refresh.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project root path',
        },
      },
      required: [],
    },
  },
];

const TOOLS = TOOL_REGISTRY.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

module.exports = { TOOL_REGISTRY, TOOLS };
