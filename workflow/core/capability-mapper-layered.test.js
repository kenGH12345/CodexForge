'use strict';

const assert = require('assert');
const { CapabilityMapper } = require('./capability-mapper');

function testIndexOnlyLayeredInput() {
  const mapper = new CapabilityMapper();
  const mapped = mapper.mapCapabilities({
    codeGraph: {
      layered: true,
      symbolCount: 10,
      modules: [
        { name: 'core', fileCount: 2, symbolCount: 5 },
        { name: 'ui', fileCount: 1, symbolCount: 3 },
      ],
      topHotspots: [{ n: 'CoreService', k: 'class', cb: 5, c: 'hub' }],
      reusableSymbols: [{ n: 'helper', k: 'function', cb: 4, c: 'utility' }],
      topCrossModuleEdges: [{ fromModule: 'ui', toModule: 'core', count: 2 }],
      symbolLookupTable: { CoreService: ['core.json'] },
      categoryStats: { total: 10, hub: 1 },
    },
  });

  assert(mapped.scaffold.modules.includes('core'));
  assert(mapped.triggers.keywords.includes('core'));
  assert(mapped.triggers.keywords.includes('helper'));
  assert.strictEqual(mapped.categoryStats.total, 10);
}

function testUnityWePopSemanticConsumption() {
  const mapper = new CapabilityMapper();
  const mapped = mapper.mapCapabilities({
    codeGraph: {
      layered: true,
      projectRoot: 'D:/WePop_trunk_ppt',
      modules: [
        { name: 'PackageCache', shard: 'PackageCache.json', fileCount: 1000, symbolCount: 12000 },
        { name: 'Extensions', shard: 'Extensions.json', fileCount: 900, symbolCount: 10000 },
        { name: 'Scripts/Core', shard: 'Scripts_Core.json', fileCount: 100, symbolCount: 8000 },
        { name: 'Scripts/LiteCore', shard: 'Scripts_LiteCore.json', fileCount: 80, symbolCount: 4000 },
        { name: 'Scripts/UICtrl/CabinUI', shard: 'Scripts_UICtrl_CabinUI.json', fileCount: 40, symbolCount: 1500 },
        { name: 'Scripts/Systems/RushPartySys', shard: 'Scripts_Systems_RushPartySys.json', fileCount: 30, symbolCount: 900 },
        { name: 'Scripts/TDR', shard: 'Scripts_TDR.json', fileCount: 30, symbolCount: 800 },
        { name: 'XLuaWork', shard: 'XLuaWork.json', fileCount: 20, symbolCount: 300 },
      ],
      shards: {},
      topHotspots: [],
      reusableSymbols: [{ name: 'TriggerEvent', kind: 'function', file: 'Assets/Scripts/Core/EventBus.cs', line: 10 }],
      categoryStats: {},
    },
  });

  const names = mapped.architecture.modules.map(m => m.name);
  assert.strictEqual(mapped.scaffold.projectName, 'WePop_trunk_ppt');
  assert.strictEqual(mapped.scaffold.projectType, 'unity-csharp-game-client');
  assert(names.includes('Assets/Scripts/Core'));
  assert(names.includes('Assets/Scripts/LiteCore'));
  assert(names.includes('Assets/Scripts/UICtrl'));
  assert(names.includes('Assets/Scripts/Systems'));
  assert(names.includes('Assets/Scripts/TDR'));
  assert(names.includes('Assets/XLuaWork'));
  assert(!names.includes('PackageCache'));
  assert(mapped.architecture.externalModules.some(m => m.name === 'PackageCache'));
  assert(mapped.triggers.keywords.some(k => /uictrl/i.test(k)));
  assert(mapped.highValueSymbols.some(s => s.name === 'TriggerEvent'));
}

testIndexOnlyLayeredInput();
testUnityWePopSemanticConsumption();
console.log('✅ capability-mapper layered semantic consumption tests passed');
