/**
 * Tree-sitter AST Adapter – High-Precision Symbol Extraction
 * 
 * ADR-XX (P0 AST Integration): Tree-sitter based symbol extraction
 * providing AST-level precision compared to regex-based extraction.
 * 
 * Design Principles:
 *   1. Dual-mode: AST primary, regex fallback (IDE-First principle)
 *   2. Incremental parsing: Reuse tree-sitter's native incremental capabilities
 *   3. Structural fingerprints: Content + AST hash for fine-grained change detection
 *   4. Worker-thread safe: No Parser instance sharing across Workers
 * 
 * @module tree-sitter-adapter
 */

'use strict';

const path = require('path');
const crypto = require('crypto');

// Tree-sitter core
let Parser = null;
let languageParsers = new Map(); // Lazy-loaded per language

// Language module cache (to avoid repeated requires)
const LANGUAGE_MODULES = {
  '.js': () => require('tree-sitter-javascript'),
  '.ts': () => require('tree-sitter-typescript').typescript,
  '.tsx': () => require('tree-sitter-typescript').tsx,
  '.py': () => require('tree-sitter-python'),
  '.go': () => require('tree-sitter-go'),
  '.cs': () => require('tree-sitter-c-sharp'),
  '.rs': () => require('tree-sitter-rust'),
  '.java': () => require('tree-sitter-java'),
  '.c': () => require('tree-sitter-c'),
  '.cpp': () => require('tree-sitter-cpp'),
  '.rb': () => require('tree-sitter-ruby'),
};

// Supported extensions for AST parsing
const SUPPORTED_EXTENSIONS = new Set(Object.keys(LANGUAGE_MODULES));

/**
 * Initialize the Tree-sitter parser (lazy singleton)
 */
function initializeParser() {
  if (Parser) return Parser;
  try {
    Parser = require('tree-sitter');
    return Parser;
  } catch (err) {
    console.warn('[TreeSitterAdapter] tree-sitter not installed, falling back to regex');
    return null;
  }
}

/**
 * Get or create a language-specific parser
 * @param {string} ext - File extension
 * @returns {Parser|null}
 */
function getLanguageParser(ext) {
  if (!Parser) Parser = initializeParser();
  if (!Parser) return null;
  
  if (languageParsers.has(ext)) {
    return languageParsers.get(ext);
  }
  
  const moduleLoader = LANGUAGE_MODULES[ext];
  if (!moduleLoader) return null;
  
  try {
    const language = moduleLoader();
    const parser = new Parser();
    parser.setLanguage(language);
    languageParsers.set(ext, parser);
    return parser;
  } catch (err) {
    console.warn(`[TreeSitterAdapter] Failed to load parser for ${ext}: ${err.message}`);
    return null;
  }
}

/**
 * Check if a file extension is supported by Tree-sitter
 * @param {string} ext 
 * @returns {boolean}
 */
function isSupported(ext) {
  return SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * Generate structural fingerprint for a file
 * Combines content hash + function signatures hash for precise change detection
 * 
 * @param {string} content - File content
 * @param {string} ext - File extension
 * @returns {{ contentHash: string, astHash: string|null, structureFingerprint: string, symbols: object[] }}
 */
function generateFingerprint(content, ext) {
  const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  
  if (!isSupported(ext)) {
    return {
      contentHash,
      astHash: null,
      structureFingerprint: contentHash,
      symbols: [],
      parserUsed: 'none',
    };
  }
  
  const parser = getLanguageParser(ext);
  if (!parser) {
    return {
      contentHash,
      astHash: null,
      structureFingerprint: contentHash,
      symbols: [],
      parserUsed: 'none',
    };
  }
  
  try {
    const tree = parser.parse(content);
    const symbols = extractSymbolsFromTree(tree, ext, content);
    
    // Generate AST structure hash based on symbol signatures
    const structureData = symbols.map(s => ({
      n: s.name,
      k: s.kind,
      s: s.signature.slice(0, 100), // Truncate for hash stability
    }));
    
    const astHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(structureData))
      .digest('hex')
      .slice(0, 16);
    
    // Combined fingerprint: content may change but structure stays same
    const structureFingerprint = `${contentHash.slice(0, 8)}:${astHash.slice(0, 8)}`;
    
    return {
      contentHash,
      astHash,
      structureFingerprint,
      symbols,
      parserUsed: 'tree-sitter',
    };
  } catch (err) {
    console.warn(`[TreeSitterAdapter] AST parsing failed: ${err.message}`);
    return {
      contentHash,
      astHash: null,
      structureFingerprint: contentHash,
      symbols: [],
      parserUsed: 'failed',
    };
  }
}

/**
 * Extract symbols from an AST tree
 * @param {Tree} tree - Tree-sitter parse tree
 * @param {string} ext - File extension
 * @param {string} source - Original source (for line number mapping)
 * @returns {Array<{name: string, kind: string, line: number, signature: string, summary: string}>}
 */
function extractSymbolsFromTree(tree, ext, source) {
  const symbols = [];
  const rootNode = tree.rootNode;
  
  // Walk the tree and extract symbols
  const cursor = rootNode.walk();
  
  // Language-specific node type mappings
  const nodeTypes = getNodeTypesForLanguage(ext);
  
  do {
    const node = cursor.currentNode;
    const symbol = extractSymbolFromNode(node, nodeTypes, source);
    
    if (symbol) {
      symbols.push(symbol);
    }
    
    // Special handling: descend into certain containers
    if (shouldDescend(node, nodeTypes)) {
      if (cursor.gotoFirstChild()) continue;
    }
  } while (cursor.gotoNextSibling() || cursor.gotoParent());
  
  return symbols;
}

/**
 * Get node type mappings for a specific language
 */
function getNodeTypesForLanguage(ext) {
  const common = {
    functionDeclaration: ['function_declaration', 'function_definition', 'method_definition'],
    classDeclaration: ['class_declaration', 'class_definition', 'struct_declaration'],
    interfaceDeclaration: ['interface_declaration', 'interface_definition'],
    variableDeclaration: ['variable_declaration', 'lexical_declaration', 'const_declaration'],
    exportDeclaration: ['export_statement', 'export_declaration'],
    decorator: ['decorator', 'attribute', 'annotation'],
    comment: ['comment', 'line_comment', 'block_comment'],
  };
  
  switch (ext) {
    case '.js':
    case '.ts':
    case '.tsx':
      return {
        ...common,
        arrowFunction: ['arrow_function'],
        methodDefinition: ['method_definition'],
        classProperty: ['public_field_definition', 'property_definition'],
        asyncFunction: ['async_function_declaration'],
      };
    case '.py':
      return {
        ...common,
        functionDeclaration: ['function_definition'],
        classDeclaration: ['class_definition'],
        methodDefinition: ['function_definition'],
        decorator: ['decorator'],
      };
    case '.go':
      return {
        ...common,
        functionDeclaration: ['function_declaration'],
        methodDeclaration: ['method_declaration'],
        structDeclaration: ['type_declaration'],
        interfaceDeclaration: ['type_declaration'],
      };
    case '.cs':
      return {
        ...common,
        functionDeclaration: ['method_declaration'],
        propertyDeclaration: ['property_declaration'],
        namespaceDeclaration: ['namespace_declaration'],
      };
    case '.rs':
      return {
        ...common,
        functionDeclaration: ['function_item'],
        implDeclaration: ['impl_item'],
        traitDeclaration: ['trait_item'],
      };
    default:
      return common;
  }
}

/**
 * Determine if we should descend into a node's children
 */
function shouldDescend(node, types) {
  const descendTypes = [
    ...types.classDeclaration,
    ...types.functionDeclaration,
    ...types.interfaceDeclaration,
    'program',
    'source_file',
    'module',
  ];
  return descendTypes.some(t => node.type.includes(t));
}

/**
 * Extract a symbol from an AST node
 */
function extractSymbolFromNode(node, types, source) {
  const lines = source.split('\n');
  
  // Function detection
  if (types.functionDeclaration.some(t => node.type === t)) {
    return extractFunctionSymbol(node, lines, 'function');
  }
  
  // Method detection
  if (types.methodDefinition && types.methodDefinition.some(t => node.type === t)) {
    return extractFunctionSymbol(node, lines, 'method');
  }
  
  // Class detection
  if (types.classDeclaration.some(t => node.type === t)) {
    return extractClassSymbol(node, lines);
  }
  
  // Interface detection
  if (types.interfaceDeclaration.some(t => node.type === t)) {
    return extractClassSymbol(node, lines, 'interface');
  }
  
  return null;
}

/**
 * Extract function symbol details from AST node
 */
function extractFunctionSymbol(node, lines, kind = 'function') {
  const nameNode = node.children.find(n => 
    n.type === 'identifier' || 
    n.type === 'property_identifier' ||
    n.type === 'word'
  );
  
  if (!nameNode) return null;
  
  const name = nameNode.text;
  const line = node.startPosition.row + 1;
  
  // Extract parameters
  const paramsNode = node.children.find(n => 
    n.type === 'formal_parameters' ||
    n.type === 'parameters' ||
    n.type === 'parameter_list'
  );
  
  let signature = '';
  if (paramsNode) {
    const paramNames = extractParamNames(paramsNode);
    signature = `(${paramNames.join(', ')})`;
  }
  
  // Extract doc comment
  const summary = extractDocComment(node, lines);
  
  // Extract decorators/attributes
  const decorators = extractDecorators(node);
  
  return {
    name,
    kind,
    line,
    signature,
    summary,
    decorators,
    isAsync: node.text.includes('async'),
    isExport: false,
  };
}

/**
 * Extract class symbol details
 */
function extractClassSymbol(node, lines, kind = 'class') {
  const nameNode = node.children.find(n => 
    n.type === 'identifier' || n.type === 'word' || n.type === 'type_identifier'
  );
  
  if (!nameNode) return null;
  
  const name = nameNode.text;
  const line = node.startPosition.row + 1;
  
  // Extract inheritance
  const heritageNode = node.children.find(n =>
    n.type === 'class_heritage' ||
    n.type === 'superclass' ||
    n.type === 'extends_clause'
  );
  
  let signature = '';
  if (heritageNode) {
    const parentName = heritageNode.text.replace(/^extends|implements/i, '').trim();
    signature = parentName.slice(0, 40);
  }
  
  // Extract doc comment
  const summary = extractDocComment(node, lines);
  
  return {
    name,
    kind,
    line,
    signature,
    summary,
  };
}

/**
 * Extract parameter names from parameter node
 */
function extractParamNames(paramsNode) {
  const names = [];
  
  function walkParams(node) {
    if (!node.children) return;
    
    for (const child of node.children) {
      if (child.type === 'identifier' || child.type === 'word') {
        names.push(child.text);
      } else if (child.type.includes('parameter') || child.type.includes('pattern')) {
        walkParams(child);
      }
    }
  }
  
  walkParams(paramsNode);
  return names.slice(0, 5);
}

/**
 * Extract documentation comment above a node
 */
function extractDocComment(node, lines) {
  const startLine = node.startPosition.row;
  
  // Look backwards for comment lines
  const comments = [];
  for (let i = startLine - 1; i >= Math.max(0, startLine - 5); i--) {
    const line = lines[i] || '';
    const trimmed = line.trim();
    
    // JSDoc / C# XML / Go style
    const docMatch = trimmed.match(/^\s*(\/\/\/|#|\/\/|\*)\s*(.+)$/);
    if (docMatch) {
      const content = docMatch[2];
      if (content && !content.startsWith('@') && !content.startsWith('param')) {
        comments.unshift(content);
      }
    } else if (trimmed === '' || trimmed === '/**' || trimmed === '*/') {
      continue;
    } else {
      break;
    }
  }
  
  return comments.slice(0, 2).join(' ').slice(0, 80);
}

/**
 * Extract decorators/annotations from a node
 */
function extractDecorators(node) {
  const decorators = [];
  
  // Look for sibling nodes before this node that are decorators
  let prev = node.previousSibling;
  while (prev && prev.type.includes('decorator')) {
    decorators.unshift(prev.text.slice(0, 30));
    prev = prev.previousSibling;
  }
  
  return decorators;
}

/**
 * Parse a single file and return AST-based symbols
 * Primary entry point for CodeGraph integration
 * 
 * @param {string} content - File content
 * @param {string} relPath - Relative file path
 * @param {string} ext - File extension
 * @returns {{ symbols: object[], fingerprint: object, usedAST: boolean }}
 */
function parseFile(content, relPath, ext) {
  if (!isSupported(ext)) {
    return {
      symbols: [],
      fingerprint: { structureFingerprint: null },
      usedAST: false,
    };
  }
  
  const fingerprint = generateFingerprint(content, ext);
  
  return {
    symbols: fingerprint.symbols.map(s => ({
      ...s,
      file: relPath,
      id: `${relPath}::${s.name}`,
    })),
    fingerprint: {
      contentHash: fingerprint.contentHash,
      astHash: fingerprint.astHash,
      structureFingerprint: fingerprint.structureFingerprint,
      parserUsed: fingerprint.parserUsed,
    },
    usedAST: fingerprint.parserUsed === 'tree-sitter',
  };
}

/**
 * Test if Tree-sitter is available and working
 */
function testAvailability() {
  const parser = initializeParser();
  if (!parser) return false;
  
  // Test with simple JS
  try {
    const jsParser = getLanguageParser('.js');
    if (!jsParser) return false;
    
    const tree = jsParser.parse('function test() {}');
    return tree.rootNode !== null;
  } catch (err) {
    return false;
  }
}

module.exports = {
  // Core API
  parseFile,
  generateFingerprint,
  extractSymbolsFromTree,
  
  // Utilities
  isSupported,
  getLanguageParser,
  initializeParser,
  testAvailability,
  
  // Constants
  SUPPORTED_EXTENSIONS: Array.from(SUPPORTED_EXTENSIONS),
  LANGUAGE_MODULES: Object.keys(LANGUAGE_MODULES),
};