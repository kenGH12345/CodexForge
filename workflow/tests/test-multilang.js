'use strict';
const ts = require('../core/ast-parsers/tree-sitter-adapter');

// Only test getLanguageParser + raw parse, no symbol extraction
const cases = [
  ['.java', 'public class Foo { public void bar(int x) {} }'],
  ['.rs', 'fn main() {} struct Point { x: i32 }'],
  ['.cpp', 'class Foo {}; void bar(int x) { }'],
  ['.c', 'int add(int a, int b) { return a + b; }'],
];

for (const [ext, code] of cases) {
  const parser = ts.getLanguageParser(ext);
  if (!parser) { console.log(ext, 'NO PARSER'); continue; }
  const tree = parser.parse(code);
  const root = tree.rootNode;
  // Print top-level child types
  const childTypes = [];
  for (let i = 0; i < root.childCount; i++) {
    const c = root.child(i);
    childTypes.push(c.type);
  }
  console.log(ext, 'root children:', childTypes.join(', '));
}

// Java
const javaCode = 'public class Foo { public void bar(int x) { baz(); } }';
const jr = ts.parseFile(javaCode, 'Foo.java', '.java');
test('Java', jr.symbols, ts.extractCallEdges(javaCode, '.java'));

// Rust
const rustCode = 'fn main() { } struct Point { x: i32, y: i32 } impl Point { fn new() -> Self { Point { x: 0, y: 0 } } }';
const rr = ts.parseFile(rustCode, 'main.rs', '.rs');
test('Rust', rr.symbols, ts.extractCallEdges(rustCode, '.rs'));

// C++
const cppCode = 'class Foo { public: void bar(int x); }; void Foo::bar(int x) { baz(); }';
const cr = ts.parseFile(cppCode, 'foo.cpp', '.cpp');
test('C++', cr.symbols, ts.extractCallEdges(cppCode, '.cpp'));

// C
const cCode = 'int add(int a, int b) { return a + b; } void main() { add(1,2); }';
const ccr = ts.parseFile(cCode, 'main.c', '.c');
test('C', ccr.symbols, ts.extractCallEdges(cCode, '.c'));
