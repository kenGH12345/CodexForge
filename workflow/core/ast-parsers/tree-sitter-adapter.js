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
    if (process.env.WF_DEBUG || globalThis._verbose) {
      console.warn(`[TreeSitterAdapter] AST parsing failed: ${err.message}`);
    }
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
  const nodeTypes = getNodeTypesForLanguage(ext);

  function walk(node, depth) {
    if (depth > 50) return;
    const symbol = extractSymbolFromNode(node, nodeTypes, source);
    if (symbol) symbols.push(symbol);
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i), depth + 1);
    }
  }

  walk(tree.rootNode, 0);
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
        classDeclaration: ['struct_item', 'enum_item'],
        implDeclaration: ['impl_item'],
        traitDeclaration: ['trait_item'],
      };
    case '.java':
      return {
        ...common,
        functionDeclaration: ['method_declaration', 'constructor_declaration'],
        classDeclaration: ['class_declaration', 'enum_declaration'],
        interfaceDeclaration: ['interface_declaration'],
      };
    case '.cpp':
    case '.c':
      return {
        ...common,
        functionDeclaration: ['function_definition'],
        classDeclaration: ['class_specifier', 'struct_specifier'],
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
    ...(types.interfaceDeclaration || []),
    ...(types.implDeclaration || []),
    'program',
    'source_file',
    'module',
    'class_body',
    'declaration_list',
  ];
  return descendTypes.some(t => node.type === t);
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
  let nameNode = node.children.find(n => 
    n.type === 'identifier' || 
    n.type === 'property_identifier' ||
    n.type === 'word'
  );
  if (!nameNode) {
    const declarator = node.children.find(n => n.type === 'function_declarator');
    if (declarator) {
      nameNode = declarator.children.find(n => n.type === 'identifier');
    }
  }
  
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
    endLine: node.endPosition.row + 1,
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
    endLine: node.endPosition.row + 1,
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
  
  try {
    const jsParser = getLanguageParser('.js');
    if (!jsParser) return false;
    
    const tree = jsParser.parse('function test() {}');
    return tree.rootNode !== null;
  } catch (err) {
    return false;
  }
}

/**
 * Resolve callee identifier from a call expression node.
 * Handles: identifier(), member.expr(), generic<T>(), qualified::name(), etc.
 *
 * @param {SyntaxNode} callNode - A call_expression / method_invocation / invocation_expression node
 * @returns {string|null} - The resolved callee name (last segment) or null
 */
function _getCalleeName(callNode) {
  if (!callNode) return null;

  switch (callNode.type) {
    case 'call_expression': {
      const fn = callNode.childForFieldName('function');
      if (!fn) return null;
      if (fn.type === 'identifier') {
        return fn.text;
      }
      if (fn.type === 'member_expression') {
        const prop = fn.childForFieldName('property');
        if (prop) return prop.text;
      }
      if (fn.type === 'qualified_identifier' || fn.type === 'scoped_identifier') {
        return fn.text.split(/::|\./).pop();
      }
      return fn.text.split(/\.|::/).pop();
    }
    case 'method_invocation': {
      const nameNode = callNode.childForFieldName('name');
      if (nameNode) return nameNode.text;
      return null;
    }
    case 'invocation_expression': {
      // C#: invocation_expression → member_access or identifier
      const expr = callNode.childForFieldName('expression');
      if (!expr) return null;
      if (expr.type === 'identifier') return expr.text;
      if (expr.type === 'member_access_expression') {
        const name = expr.childForFieldName('name');
        if (name) return name.text;
      }
      return expr.text.split('.').pop();
    }
    default:
      return callNode.text.split(/\.|::/).pop();
  }
}

/**
 * Find which function/method definition contains a given node.
 * Walks upward through parent nodes to find the nearest function container.
 *
 * @param {SyntaxNode} node - The AST node to find container for
 * @returns {SyntaxNode|null} - The containing function node, or null if at top level
 */
function _findContainingFunction(node) {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'function_declaration' ||
      current.type === 'function_definition' ||
      current.type === 'method_definition' ||
      current.type === 'class_method' ||
      current.type === 'method_declaration' ||
      current.type === 'function_item' ||
      current.type === 'arrow_function' ||
      current.type === 'generator_function' ||
      current.type === 'constructor_declaration'
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Extract call edges from source using AST, grouped by containing function.
 * Returns null when tree-sitter is unavailable (caller should fall back to regex).
 *
 * @param {string} content - File source code
 * @param {string} ext - File extension (e.g. '.js')
 * @returns {Array<{functionName: string, calleeNames: string[]}>|null}
 */
function extractCallEdges(content, ext) {
  const parser = getLanguageParser(ext);
  if (!parser) return null;

  // Call expression node types by language family
  const CALL_NODE_TYPES = new Set([
    'call_expression',      // JS/TS, Python, Go, Rust, C, C++, Ruby
    'method_invocation',    // Java, C# (legacy)
    'invocation_expression', // C#
    'function_call',        // Pascal, Elixir
    'call',                 // Ruby, Haskell, Erlang
  ]);

  try {
    const tree = parser.parse(content);
    const functionCalls = new Map(); // functionName -> Set(calleeNames)

    function walk(node) {
      if (CALL_NODE_TYPES.has(node.type)) {
        const callee = _getCalleeName(node);
        if (callee) {
          const container = _findContainingFunction(node);
          const containerName = container
            ? (container.childForFieldName('name')?.text || '<anonymous>')
            : '<global>';

          if (!functionCalls.has(containerName)) {
            functionCalls.set(containerName, new Set());
          }
          functionCalls.get(containerName).add(callee);
        }
      }
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i));
      }
    }

    walk(tree.rootNode);

    // Convert to array format
    const result = [];
    for (const [functionName, calleeSet] of functionCalls) {
      result.push({ functionName, calleeNames: Array.from(calleeSet) });
    }
    return result.length > 0 ? result : null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  // Core API
  parseFile,
  generateFingerprint,
  extractSymbolsFromTree,
  extractCallEdges,
  
  // Utilities
  isSupported,
  getLanguageParser,
  initializeParser,
  testAvailability,
  
  // Constants
  SUPPORTED_EXTENSIONS: Array.from(SUPPORTED_EXTENSIONS),
  LANGUAGE_MODULES: Object.keys(LANGUAGE_MODULES),
};