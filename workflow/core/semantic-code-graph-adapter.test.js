'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSemanticCodeGraph } = require('./semantic-code-graph-adapter');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-code-graph-'));
try {
  const output = path.join(root, 'output');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'code-graph-index.json'), JSON.stringify({
    version: 'test',
    projectRoot: root,
    symbolCount: 100,
    modules: [
      { name: 'PackageCache', shard: 'PackageCache.json', fileCount: 100, symbolCount: 1000 },
      { name: 'Extensions', shard: 'Extensions.json', fileCount: 90, symbolCount: 900 },
      { name: 'Scripts/Core', shard: 'Scripts_Core.json', fileCount: 10, symbolCount: 500 },
      { name: 'Scripts/UICtrl/MainGameUI', shard: 'Scripts_UICtrl_MainGameUI.json', fileCount: 8, symbolCount: 300 },
      { name: 'Scripts/Systems/RushPartySys', shard: 'Scripts_Systems_RushPartySys.json', fileCount: 6, symbolCount: 200 },
      { name: 'Scripts/TDR', shard: 'Scripts_TDR.json', fileCount: 5, symbolCount: 150 },
      { name: 'XLuaWork', shard: 'XLuaWork.json', fileCount: 3, symbolCount: 80 }
    ],
    topHotspots: [],
    reusableSymbols: [{ name: 'TriggerEvent', kind: 'function', file: 'Assets/Scripts/Core/EventBus.cs', line: 1 }],
    categoryStats: {}
  }), 'utf8');

  const adapter = loadSemanticCodeGraph(root, { includeTopShards: true, maxShards: 4 });
  const summary = adapter.getArchitectureSummary({ maxModules: 10 });
  const dirs = summary.modules.map(m => m.dir);
  assert(dirs.includes('Assets/Scripts/Core'));
  assert(dirs.includes('Assets/Scripts/UICtrl'));
  assert(dirs.includes('Assets/Scripts/Systems'));
  assert(dirs.includes('Assets/Scripts/TDR'));
  assert(dirs.includes('Assets/XLuaWork'));
  assert(!dirs.includes('PackageCache'));
  assert(summary.externalModules.some(m => m.dir === 'PackageCache'));

  const terms = adapter.getSkillSignalTerms(80).join(' ');
  assert(terms.includes('UICtrl'));
  assert(terms.includes('Systems'));
  assert(terms.includes('TDR'));
  assert(!terms.includes('PackageCache'), 'PackageCache should not be a primary skill matching signal');

  console.log('PASS semantic-code-graph-adapter tests');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
