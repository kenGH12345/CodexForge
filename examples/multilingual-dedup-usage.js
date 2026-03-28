/**
 * Usage Example: Multilingual Support & Content Deduplication
 *
 * Demonstrates the P1 enhancements:
 * 1. Multilingual keyword extraction
 * 2. Content-based similarity detection
 * 3. Experience clustering and deduplication
 */

'use strict';

const path = require('path');
const {
  ExperienceStore,
  ExperienceDeduplicator,
  extractKeywords,
} = require('../workflow/core/experience-store');
const { detectLanguage } = require('../workflow/core/experience-query');

// ─── Example 1: Multilingual Keyword Extraction ─────────────────────────────

console.log('\n🔤 Example 1: Multilingual Keyword Extraction\n');

const texts = {
  english: 'Always use async/await for database operations in Node.js applications',
  chinese: '在 React 组件中使用 useCallback 来优化性能，避免不必要的重渲染',
  japanese: 'TypeScript でインターフェースを定義する際は、readonly プロパティを使用してください',
  korean: 'Kubernetes 클러스터에서의 에러 처리는 반드시 재시도 로직을 구현해야 합니다',
  mixed: '微服务架构中使用 gRPC 进行通信，ensure type safety with Protocol Buffers',
};

for (const [lang, text] of Object.entries(texts)) {
  const detected = detectLanguage(text);
  const keywords = extractKeywords(text, 8);
  console.log(`${lang.padEnd(10)} (${detected})`);
  console.log(`  Text: ${text.slice(0, 50)}...`);
  console.log(`  Keywords: ${keywords.join(', ')}`);
  console.log();
}

// ─── Example 2: Experience Store with Content Deduplication ─────────────────

console.log('\n📚 Example 2: Experience Store with Content Deduplication\n');

const store = new ExperienceStore(path.join(__dirname, 'temp-experience-store.json'));

// Add some experiences
const experiences = [
  {
    type: 'POSITIVE',
    category: 'stable_pattern',
    title: 'Use React useCallback',
    content: 'Always use useCallback to memoize callback functions in React components',
    skill: 'react',
    tags: ['react', 'performance'],
  },
  {
    type: 'POSITIVE',
    category: 'stable_pattern',
    title: 'React Performance Tip',
    content: 'Using useCallback hook helps optimize React component performance by memoizing callbacks',
    skill: 'react',
    tags: ['react', 'optimization'],
  },
  {
    type: 'POSITIVE',
    category: 'stable_pattern',
    title: 'React 中使用 useCallback',
    content: '在 React 组件中使用 useCallback 来缓存回调函数，避免不必要的重新渲染',
    skill: 'react',
    tags: ['react', '性能'],
  },
  {
    type: 'NEGATIVE',
    category: 'pitfall',
    title: 'Avoid overusing useCallback',
    content: 'Adding useCallback to every function causes more harm than good',
    skill: 'react',
    tags: ['react', 'antipattern'],
  },
];

// Record experiences with content-based duplicate detection
for (const exp of experiences) {
  const recorded = store.recordWithContentCheck(exp, 0.7);
  console.log(`✅ Recorded: "${recorded.title}" (ID: ${recorded.id.slice(0, 8)}...)`);
}

// ─── Example 3: Find Similar Content ─────────────────────────────────────────

console.log('\n🔍 Example 3: Find Similar Content\n');

const query = {
  title: 'Optimize React with useCallback',
  content: 'How to use useCallback for performance optimization in React',
  type: 'POSITIVE',
};

const similar = store.findSimilarByContent(query, 0.3);
console.log(`Found ${similar.length} similar experiences:`);
for (const { exp, similarity } of similar) {
  console.log(`  • "${exp.title}" - ${(similarity * 100).toFixed(1)}% similar`);
}

// ─── Example 4: Analyze Duplicates ──────────────────────────────────────────

console.log('\n📊 Example 4: Duplicate Analysis\n');

const analysis = store.analyzeContentDuplicates({ similarityThreshold: 0.5 });
console.log(`Total experiences: ${analysis.totalExperiences}`);
console.log(`Multi-member clusters: ${analysis.clusters.length}`);
console.log(`Duplicate groups: ${analysis.duplicateGroups.length}`);

if (analysis.clusters.length > 0) {
  console.log('\nClusters found:');
  for (const cluster of analysis.clusters) {
    console.log(`  • ${cluster.id}: ${cluster.members.length} experiences`);
    console.log(`    Avg similarity: ${(cluster.avgSimilarity * 100).toFixed(1)}%`);
    console.log(`    Representative: "${cluster.representative.title}"`);
  }
}

if (analysis.mergeSuggestions.length > 0) {
  console.log('\nMerge suggestions:');
  for (const suggestion of analysis.mergeSuggestions.slice(0, 3)) {
    console.log(`  • ${suggestion.memberCount} members (${(suggestion.avgSimilarity * 100).toFixed(0)}% similar)`);
    console.log(`    Rationale: ${suggestion.rationale}`);
  }
}

// ─── Example 5: Direct Deduplicator Usage ───────────────────────────────────

console.log('\n🎯 Example 5: Direct Deduplicator Usage\n');

const deduplicator = new ExperienceDeduplicator({
  similarityThreshold: 0.6,
  clusterThreshold: 0.4,
});

// Use the store's experiences
const clusters = deduplicator.cluster(store.experiences);
console.log(`Clustered ${store.experiences.length} experiences into ${clusters.length} clusters`);

// ─── Cleanup ────────────────────────────────────────────────────────────────

// Clean up temp file
const fs = require('fs');
try {
  fs.unlinkSync(path.join(__dirname, 'temp-experience-store.json'));
} catch (e) {
  // Ignore
}

console.log('\n✨ Demo completed!\n');