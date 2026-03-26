const test = require('node:test');
const assert = require('node:assert/strict');

const solver = require('./solver_core.js');

test('solver respects duplicate upper bounds from gray feedback', function () {
  const rows = [{ word: 'civic', pattern: '22000' }];
  const words = ['cigar', 'cider', 'cynic', 'civic'];
  const result = solver.analyze(rows, words, 5);

  assert.deepEqual(result.candidates, ['cider', 'cigar']);
});

test('solver excludes yellow letters from the same position', function () {
  const rows = [{ word: 'cigar', pattern: '11000' }];
  const words = ['tonic', 'cider', 'panic', 'radii'];
  const result = solver.analyze(rows, words, 5);

  assert.deepEqual(result.candidates, ['tonic']);
});

test('sortCandidates prefers unique letters before frequency score', function () {
  const sorted = solver.sortCandidates(['aaaa', 'abce', 'abcd']);
  assert.deepEqual(sorted.slice(0, 2), ['abcd', 'abce']);
});
