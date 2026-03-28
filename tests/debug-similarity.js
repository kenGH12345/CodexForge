/**
 * Debug script for similarity calculation
 */

const {
  computeExperienceSimilarity,
  computeNGramFingerprint,
  computeMinHash,
  computeMinHashSimilarity,
  computeJaccardSimilarity,
} = require('../workflow/core/experience-query');

const exp1 = {
  id: 'exp-1',
  type: 'POSITIVE',
  category: 'stable_pattern',
  title: 'Use React useCallback for Performance',
  content: 'Always use useCallback to memoize callback functions in React components to prevent unnecessary re-renders',
  tags: ['react', 'performance'],
};

const exp2 = {
  id: 'exp-2',
  type: 'POSITIVE',
  category: 'stable_pattern',
  title: 'React Performance with useCallback',
  content: 'Using useCallback hook helps optimize React component performance by memoizing callbacks',
  tags: ['react', 'optimization'],
};

console.log('=== Experience 1 ===');
console.log('Title:', exp1.title);
console.log('Content:', exp1.content);

console.log('\n=== Experience 2 ===');
console.log('Title:', exp2.title);
console.log('Content:', exp2.content);

console.log('\n=== N-Gram Fingerprints ===');
const titleFp1 = computeNGramFingerprint(exp1.title.toLowerCase(), 3);
const titleFp2 = computeNGramFingerprint(exp2.title.toLowerCase(), 3);
const contentFp1 = computeNGramFingerprint(exp1.content.toLowerCase(), 3);
const contentFp2 = computeNGramFingerprint(exp2.content.toLowerCase(), 3);

console.log('\nTitle FP 1:', Array.from(titleFp1).slice(0, 10));
console.log('Title FP 2:', Array.from(titleFp2).slice(0, 10));
console.log('Title FP sizes:', titleFp1.size, titleFp2.size);

console.log('\nContent FP 1:', Array.from(contentFp1).slice(0, 10));
console.log('Content FP 2:', Array.from(contentFp2).slice(0, 10));
console.log('Content FP sizes:', contentFp1.size, contentFp2.size);

console.log('\n=== Jaccard Similarity ===');
const titleJaccard = computeJaccardSimilarity(titleFp1, titleFp2);
const contentJaccard = computeJaccardSimilarity(contentFp1, contentFp2);
console.log('Title Jaccard:', titleJaccard);
console.log('Content Jaccard:', contentJaccard);

console.log('\n=== MinHash Similarity ===');
const titleSig1 = computeMinHash(titleFp1);
const titleSig2 = computeMinHash(titleFp2);
const contentSig1 = computeMinHash(contentFp1);
const contentSig2 = computeMinHash(contentFp2);

const titleMinHash = computeMinHashSimilarity(titleSig1, titleSig2);
const contentMinHash = computeMinHashSimilarity(contentSig1, contentSig2);
console.log('Title MinHash:', titleMinHash);
console.log('Content MinHash:', contentMinHash);

console.log('\n=== Overall Similarity ===');
const similarity = computeExperienceSimilarity(exp1, exp2);
console.log('Overall similarity:', similarity);

// Manual calculation
const titleWeight = 0.3;
const contentWeight = 0.7;
const manualSim = titleJaccard * titleWeight + contentJaccard * contentWeight;
console.log('Manual calc (using Jaccard):', manualSim);