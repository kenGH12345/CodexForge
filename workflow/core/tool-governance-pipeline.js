'use strict';

function createToolGovernance(config = {}) {
  const userCfg = config.toolGovernance && typeof config.toolGovernance === 'object'
    ? config.toolGovernance
    : {};
  return {
    enabled: userCfg.enabled !== false,
    maxInputLength: Number(userCfg.maxInputLength || 12000),
    allowFallback: userCfg.allowFallback !== false,
  };
}

async function executeWithToolGovernance({
  command,
  input,
  handler,
  preValidate,
  postProcess,
  fallback,
  config = {},
}) {
  const governance = createToolGovernance(config);

  if (!governance.enabled) {
    return handler();
  }

  const rawInput = typeof input === 'string' ? input : JSON.stringify(input || {});
  if (rawInput.length > governance.maxInputLength) {
    return {
      success: false,
      error: `Input too large for governed execution (${rawInput.length} > ${governance.maxInputLength}).`,
      command,
      phase: 'pre-validate',
    };
  }

  if (typeof preValidate === 'function') {
    const pre = await preValidate();
    if (pre && pre.success === false) {
      return {
        ...pre,
        command,
        phase: 'pre-validate',
      };
    }
  }

  try {
    let result = await handler();

    if (typeof postProcess === 'function') {
      result = await postProcess(result);
    }

    return {
      ...(result || {}),
      governance: {
        enabled: true,
        command,
        phase: 'done',
      },
    };
  } catch (err) {
    if (governance.allowFallback && typeof fallback === 'function') {
      const fallbackResult = await fallback(err);
      return {
        ...(fallbackResult || {}),
        governance: {
          enabled: true,
          command,
          phase: 'fallback',
          reason: err.message,
        },
      };
    }

    return {
      success: false,
      command,
      phase: 'execute',
      error: err.message,
    };
  }
}

module.exports = {
  createToolGovernance,
  executeWithToolGovernance,
};