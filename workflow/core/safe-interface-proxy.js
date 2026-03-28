/**
 * Safe Interface Proxy – Bottom-up prevention of "dark disconnection" bugs
 *
 * ## The Problem
 *
 * In JavaScript's duck-typing world, calling a non-existent method on an object
 * returns `undefined` instead of throwing. Combined with defensive patterns like
 * `typeof obj.method === 'function'` and `try/catch`, this creates "dark
 * disconnections" — broken cross-module interfaces that fail silently.
 *
 * Real example: stage-analyst.js called `experienceStore.query()` for months,
 * but ExperienceStore never had a `query()` method. The typeof check silently
 * skipped the entire code block, and the try/catch swallowed any error.
 * Result: experience injection never worked in ANALYSE/PLAN stages.
 *
 * ## The Solution
 *
 * ES6 Proxy's `get` trap intercepts ALL property access on an object. When
 * someone accesses a property that doesn't exist AND then tries to call it
 * as a function, we throw a loud, descriptive error immediately.
 *
 * This is applied at the object creation point (in the Orchestrator constructor),
 * so ALL consumers are protected without any changes to their code.
 *
 * ## Design Decisions
 *
 * 1. **Fail-loud, not fail-silent**: The whole point is to make broken interfaces
 *    impossible to ignore. A console.error + thrown error ensures visibility.
 *
 * 2. **Only in development/debug mode by default**: Production workflows should
 *    not crash due to a missing optional method. Use `mode: 'warn'` for production
 *    and `mode: 'throw'` for development/testing.
 *
 * 3. **Zero performance overhead for existing methods**: The Proxy only intercepts
 *    access to non-existent properties. Existing properties are passed through
 *    via Reflect.get with zero overhead.
 *
 * 4. **Descriptive error messages**: Include the interface name, the missing
 *    method name, and a list of available methods to help developers fix the issue.
 *
 * @module safe-interface-proxy
 */

'use strict';

/**
 * Wraps an object with an ES6 Proxy that detects access to non-existent methods.
 *
 * @param {object} instance     - The real object to protect
 * @param {string} interfaceName - Human-readable name (e.g. 'ExperienceStore', 'Observability')
 * @param {object} [options]
 * @param {'throw'|'warn'|'silent'} [options.mode='warn'] - How to handle violations:
 *   - 'throw': Throw an error immediately (best for tests)
 *   - 'warn':  Log a loud warning but return a no-op function (best for production)
 *   - 'silent': Only log, never throw (escape hatch)
 * @param {Set<string>} [options.allowList] - Property names to exclude from checking
 *   (e.g. Symbol.iterator, 'then' for Promise detection, 'toJSON', etc.)
 * @returns {Proxy} A proxy that behaves identically to the original object,
 *   but catches access to non-existent methods.
 */
function createSafeProxy(instance, interfaceName, options = {}) {
  if (!instance || typeof instance !== 'object') {
    return instance; // Don't wrap primitives or null
  }

  const mode = options.mode || 'warn';

  // Properties that are commonly probed by Node.js internals, Promise detection,
  // JSON serialization, etc. We must NOT flag these as violations.
  const BUILTIN_PROBES = new Set([
    'then',           // Promise.resolve() probes for .then
    'catch',          // Promise detection
    'toJSON',         // JSON.stringify
    'inspect',        // Node.js util.inspect
    'valueOf',        // Type coercion
    'toString',       // Type coercion
    'constructor',    // instanceof checks
    'hasOwnProperty', // Object.prototype
    'isPrototypeOf',  // Object.prototype
    'propertyIsEnumerable', // Object.prototype
    'Symbol(Symbol.toPrimitive)',
    'Symbol(Symbol.toStringTag)',
    'Symbol(Symbol.iterator)',
    'Symbol(nodejs.util.inspect.custom)',
    // Node.js module system probes
    '__esModule',
    'default',
    // Common test framework probes
    'asymmetricMatch',
    'nodeType',
    '@@__IMMUTABLE_ITERABLE__@@',
    '@@__IMMUTABLE_RECORD__@@',
  ]);

  const allowList = options.allowList || new Set();

  // Cache the list of own methods for the error message
  let _methodListCache = null;
  function getMethodList() {
    if (_methodListCache) return _methodListCache;
    const methods = new Set();
    let proto = instance;
    while (proto && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (typeof proto[key] === 'function' && key !== 'constructor') {
          methods.add(key);
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    _methodListCache = [...methods].sort();
    return _methodListCache;
  }

  return new Proxy(instance, {
    get(target, prop, receiver) {
      // 1. Symbols are always passed through (Symbol.iterator, Symbol.toPrimitive, etc.)
      if (typeof prop === 'symbol') {
        return Reflect.get(target, prop, receiver);
      }

      // 2. Properties that exist on the target are passed through with zero overhead
      if (prop in target) {
        return Reflect.get(target, prop, receiver);
      }

      // 3. Built-in probes and allow-listed properties are passed through silently
      if (BUILTIN_PROBES.has(prop) || allowList.has(prop)) {
        return undefined;
      }

      // 4. Properties starting with _ are considered internal/private.
      //    For known high-frequency private properties that have public API alternatives,
      //    emit a deprecation warning to guide callers toward the public API.
      if (prop.startsWith('_')) {
        const PRIVATE_API_ALTERNATIVES = {
          '_symbols':    `Use ${interfaceName}.getSymbolById(id), ${interfaceName}.getSymbolCount(), or ${interfaceName}.getAllSymbolValues() instead`,
          '_save':       `Use ${interfaceName}.save() instead`,
          '_findByName': `Use ${interfaceName}.findByName() instead`,
          '_loadFromDisk': `Use ${interfaceName}.ensureLoaded() instead`,
        };
        const alt = PRIVATE_API_ALTERNATIVES[prop];
        if (alt && mode !== 'silent') {
          console.warn(
            `[SafeInterfaceProxy] ⚠️  ${interfaceName}.${prop} is a private property accessed externally.\n` +
            `  ${alt}\n` +
            `  Direct private access bypasses SafeProxy protection and may break without notice.`
          );
        }
        return Reflect.get(target, prop, receiver);
      }

      // 5. This is a genuine access to a non-existent property!
      //    Return a function that throws when called, or log a warning.
      const availableMethods = getMethodList();

      // Find similar method names (simple Levenshtein-like suggestion)
      const suggestions = availableMethods
        .filter(m => {
          // Simple similarity: shared prefix >= 3 chars, or one is substring of other
          const lp = prop.toLowerCase();
          const lm = m.toLowerCase();
          return lm.includes(lp) || lp.includes(lm) ||
                 (lp.length >= 3 && lm.startsWith(lp.slice(0, 3)));
        })
        .slice(0, 3);

      const suggestionHint = suggestions.length > 0
        ? `\n  Did you mean: ${suggestions.map(s => `${interfaceName}.${s}()`).join(', ')}?`
        : '';

      const errorMsg =
        `[SafeInterfaceProxy] ❌ ${interfaceName}.${prop} does not exist!` +
        `\n  "${prop}" is not a method or property of ${interfaceName}.` +
        suggestionHint +
        `\n  Available methods (${availableMethods.length}): ${availableMethods.slice(0, 15).join(', ')}${availableMethods.length > 15 ? '...' : ''}` +
        `\n  This is likely a cross-module interface mismatch (dark disconnection bug).` +
        `\n  Check that the caller is using the correct method name from the ${interfaceName} API.`;

      if (mode === 'throw') {
        // In 'throw' mode, return a function that throws when called
        // This way, `typeof obj.nonExistent === 'function'` returns true,
        // but actually calling it throws — catching the bug at the call site.
        return function throwingStub(...args) {
          throw new Error(errorMsg);
        };
      } else if (mode === 'warn') {
        // In 'warn' mode, log a loud warning and return a no-op
        console.error(errorMsg);
        console.error(new Error('Stack trace for debugging:').stack);
        // Return a no-op function that returns undefined
        // This prevents crashes but makes the issue highly visible
        return function warnStub(...args) {
          return undefined;
        };
      } else {
        // 'silent' mode — just return undefined (legacy behavior)
        return undefined;
      }
    },
  });
}

/**
 * Determines the appropriate proxy mode based on environment.
 *
 * - NODE_ENV=test or CODEXFORGE_STRICT_INTERFACES=1 → 'throw'
 * - NODE_ENV=development → 'warn'
 * - NODE_ENV=production → 'warn' (we still want visibility)
 *
 * @returns {'throw'|'warn'|'silent'}
 */
function getDefaultProxyMode() {
  const env = process.env.NODE_ENV || '';
  if (process.env.CODEXFORGE_STRICT_INTERFACES === '1') return 'throw';
  if (env === 'test') return 'throw';
  // Default to 'warn' — we always want visibility for dark disconnections
  return 'warn';
}

/**
 * Convenience: wraps multiple shared objects at once.
 *
 * @param {Record<string, object>} namedInstances - e.g. { experienceStore, obs, hooks }
 * @param {object} [options] - Same as createSafeProxy options
 * @returns {Record<string, Proxy>} Wrapped instances
 */
function wrapSharedObjects(namedInstances, options = {}) {
  const mode = options.mode || getDefaultProxyMode();
  const result = {};
  for (const [name, instance] of Object.entries(namedInstances)) {
    if (instance && typeof instance === 'object') {
      result[name] = createSafeProxy(instance, name, { ...options, mode });
    } else {
      result[name] = instance;
    }
  }
  return result;
}

module.exports = {
  createSafeProxy,
  getDefaultProxyMode,
  wrapSharedObjects,
};
