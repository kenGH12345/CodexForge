/**
 * Agent Tools - Standard tools for ReAct loop
 */

'use strict';

const fs = require('fs');
const path = require('path');

function getStandardTools(orchestrator) {
  return [
    {
      name: 'codebase_search',
      description: 'Search the codebase semantically for symbols, classes, or functions. Args: { "query": "search term" }',
      execute: async (args) => {
        if (!args.query) throw new Error('Missing "query" argument');
        if (!orchestrator.codeGraph) return 'CodeGraph not available.';
        
        try {
          const results = orchestrator.codeGraph.searchSymbol(args.query, { maxResults: 5 });
          if (!results || results.length === 0) return 'No results found.';
          return JSON.stringify(results, null, 2);
        } catch (err) {
          return `Search failed: ${err.message}`;
        }
      }
    },
    {
      name: 'read_file',
      description: 'Read a file from the codebase. Args: { "path": "relative/path/to/file.js" }',
      execute: async (args) => {
        if (!args.path) throw new Error('Missing "path" argument');
        const projectRoot = orchestrator._projectRoot || orchestrator.projectRoot || '.';
        const fullPath = path.resolve(projectRoot, args.path);
        
        if (!fs.existsSync(fullPath)) return `File not found: ${args.path}`;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) return `Path is a directory, not a file: ${args.path}`;
        
        const content = fs.readFileSync(fullPath, 'utf-8');
        return content;
      }
    },
    {
      name: 'grep_search',
      description: 'Search for exact text in the codebase. Args: { "query": "exact text", "dir": "optional/dir/path" }',
      execute: async (args) => {
        if (!args.query) throw new Error('Missing "query" argument');
        const projectRoot = orchestrator._projectRoot || orchestrator.projectRoot || '.';
        const searchDir = args.dir ? path.resolve(projectRoot, args.dir) : projectRoot;
        
        if (!fs.existsSync(searchDir)) return `Directory not found: ${args.dir}`;
        
        const results = [];
        const maxResults = 10;
        
        function walk(dir) {
          if (results.length >= maxResults) return;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= maxResults) return;
            if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) continue;
            
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(fullPath);
            } else if (entry.isFile()) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                if (content.includes(args.query)) {
                  const lines = content.split('\n');
                  for (let i = 0; i < lines.length; i++) {
                    if (lines[i].includes(args.query)) {
                      results.push(`${path.relative(projectRoot, fullPath)}:${i + 1}: ${lines[i].trim()}`);
                      if (results.length >= maxResults) break;
                    }
                  }
                }
              } catch (_) { /* ignore read errors */ }
            }
          }
        }
        
        walk(searchDir);
        if (results.length === 0) return 'No matches found.';
        return results.join('\n');
      }
    }
  ];
}

module.exports = { getStandardTools };
