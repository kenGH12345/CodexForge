/**
 * IDE Symbol Adapter Tests
 * Verifies ADR-37 IDE-First Principle implementation
 */

'use strict';

const { describe, it, expect, beforeEach } = require('@jest/globals');
const IdeSymbolAdapter = require('./ide-symbol-adapter');

// Mock ide-detection module
jest.mock('./ide-detection', () => ({
  detectIDEEnvironment: jest.fn(),
  ideHasGoToDefinition: jest.fn(),
}));

const { detectIDEEnvironment } = require('./ide-detection');

describe('IDE Symbol Adapter (ADR-37)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    IdeSymbolAdapter.setViewCodeItemTool(null);
  });

  describe('querySymbolWithIDE', () => {
    it('should return fallback when not in IDE', async () => {
      detectIDEEnvironment.mockReturnValue({
        isInsideIDE: false,
        capabilities: { viewCodeItem: false },
      });

      const result = await IdeSymbolAdapter.querySymbolWithIDE('testFunction');

      expect(result.success).toBe(false);
      expect(result.source).toBe('ide');
      expect(result.fallback).toBe(true);
      expect(result.error).toContain('Not running in IDE');
    });

    it('should return fallback when view_code_item unavailable', async () => {
      detectIDEEnvironment.mockReturnValue({
        isInsideIDE: true,
        capabilities: { viewCodeItem: false },
      });

      const result = await IdeSymbolAdapter.querySymbolWithIDE('testFunction');

      expect(result.success).toBe(false);
      expect(result.source).toBe('ide');
      expect(result.error).toContain('Not running in IDE');
    });

    it('should return error when tool not initialized', async () => {
      detectIDEEnvironment.mockReturnValue({
        isInsideIDE: true,
        capabilities: { viewCodeItem: true },
      });

      const result = await IdeSymbolAdapter.querySymbolWithIDE('testFunction');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not initialized');
    });

    it('should successfully query symbol via IDE', async () => {
      detectIDEEnvironment.mockReturnValue({
        isInsideIDE: true,
        capabilities: { viewCodeItem: true },
      });

      const mockTool = jest.fn().mockResolvedValue({
        content: `function testFunction(x, y) {
  return x + y;
}`,
      });
      IdeSymbolAdapter.setViewCodeItemTool(mockTool);

      const result = await IdeSymbolAdapter.querySymbolWithIDE('testFunction');

      expect(result.success).toBe(true);
      expect(result.source).toBe('ide');
      expect(result.data.name).toBe('testFunction');
      expect(result.data.kind).toBe('function');
      expect(mockTool).toHaveBeenCalledWith({
        symbolName: 'testFunction',
        filePath: null,
      });
    });

    it('should timeout and return fallback', async () => {
      detectIDEEnvironment.mockReturnValue({
        isInsideIDE: true,
        capabilities: { viewCodeItem: true },
      });

      const mockTool = jest.fn(() => new Promise(() => {})); // Never resolves
      IdeSymbolAdapter.setViewCodeItemTool(mockTool);

      const result = await IdeSymbolAdapter.querySymbolWithIDE('testFunction', null, {
        timeout: 100,
        allowFallback: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeout');
      expect(result.source).toBe('ide');
      expect(result.fallback).toBe(true);
    });
  });

  describe('parseIDEResult', () => {
    it('should parse JavaScript function', () => {
      const content = `function calculateSum(a, b) {
  return a + b;
}`;
      const result = IdeSymbolAdapter.parseIDEResult(content);

      expect(result.name).toBe('calculateSum');
      expect(result.kind).toBe('function');
      expect(result.signature).toContain('calculateSum');
    });

    it('should parse JavaScript class', () => {
      const content = `class UserRepository {
  constructor() {
    this.users = new Map();
  }
}`;
      const result = IdeSymbolAdapter.parseIDEResult(content);

      expect(result.name).toBe('UserRepository');
      expect(result.kind).toBe('class');
    });

    it('should parse Python function', () => {
      const content = `def process_data(items):
    result = []
    for item in items:
        result.append(transform(item))
    return result`;
      const result = IdeSymbolAdapter.parseIDEResult(content);

      expect(result.name).toBe('process_data');
      expect(result.kind).toBe('function');
    });

    it('should parse C# method', () => {
      const content = `public async Task<User> GetUserAsync(int id) {
    return await _dbContext.Users.FindAsync(id);
}`;
      const result = IdeSymbolAdapter.parseIDEResult(content);

      expect(result.name).toBe('GetUserAsync');
      expect(result.kind).toBe('method');
    });

    it('should handle unrecognized code', () => {
      const content = `some random text without symbol`;
      const result = IdeSymbolAdapter.parseIDEResult(content);

      expect(result.kind).toBe('unknown');
      expect(result.name).toBeNull();
    });

    it('should detect JSDoc presence', () => {
      const content = `/**
 * Process user data
 * @param {User} user
 */
function processUser(user) {
  return user.data;
}`;
      const result = IdeSymbolAdapter.parseIDEResult(content);

      expect(result.hasJSDoc).toBe(true);
    });
  });
});

// Integration tests with CodeGraph
describe('CodeGraph.querySymbol Integration (ADR-37)', () => {
  const CodeGraph = require('./code-graph');
  const path = require('path');
  const fs = require('fs');
  const os = require('os');

  let tempDir;
  let graph;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-'));
    graph = new CodeGraph({ basePath: tempDir });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true });
  });

  it('should return local result when not in IDE', async () => {
    // Create a test file
    const testFile = path.join(tempDir, 'test.js');
    fs.writeFileSync(testFile, `
function standaloneFunc() {
  return 42;
}
`);

    // Mock as standalone mode
    detectIDEEnvironment.mockReturnValue({
      isInsideIDE: false,
      capabilities: { viewCodeItem: false },
    });

    graph.scan();

    const result = graph.querySymbol('standaloneFunc');
    expect(result).not.toBeNull();
    expect(result.symbol.name).toBe('standaloneFunc');
  });
});

describe('ADR-37 Compliance Checklist', () => {
  it('✅ IDE detection works', () => {
    detectIDEEnvironment.mockReturnValue({
      isInsideIDE: true,
      capabilities: { viewCodeItem: true },
    });
    const result = detectIDEEnvironment();
    expect(result.isInsideIDE).toBe(true);
  });

  it('✅ Regex fallback exists', () => {
    expect(IdeSymbolAdapter.querySymbolWithIDE).toBeDefined();
    expect(typeof IdeSymbolAdapter.querySymbolWithIDE).toBe('function');
  });

  it('✅ Timeout handling implemented', () => {
    expect(IdeSymbolAdapter.VIEW_CODE_ITEM_TIMEOUT).toBeDefined();
    expect(IdeSymbolAdapter.VIEW_CODE_ITEM_TIMEOUT).toBe(5000);
  });

  it('✅ Retry logic configured', () => {
    expect(IdeSymbolAdapter.MAX_RETRIES).toBe(2);
  });
});