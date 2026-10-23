const test = require('node:test');
const assert = require('node:assert');
const { tokenize, matches, rank, parseSearchQuery } = require('../searchEngine');

test('tokenize lowercases, trims, and splits on whitespace', () => {
  assert.deepStrictEqual(tokenize('  Sululta   230  '), ['sululta', '230']);
});

test('tokenize returns an empty list for blank input', () => {
  assert.deepStrictEqual(tokenize(''), []);
  assert.deepStrictEqual(tokenize('   '), []);
  assert.deepStrictEqual(tokenize(null), []);
});

test('tokenize caps the raw query at 80 characters before splitting', () => {
  const raw = `${'alpha '.repeat(20)}omega`;
  const tokens = tokenize(raw);
  assert.ok(tokens.length <= 8);
  assert.ok(!tokens.includes('omega'));
});

test('tokenize keeps at most the first eight tokens', () => {
  const tokens = tokenize('one two three four five six seven eight nine ten');
  assert.deepStrictEqual(tokens, ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']);
});

test('matches requires every token to appear in at least one field', () => {
  const fields = ['Sululta 400kV Auto Transformer', 'ASSET-12', 'TRANSFORMER'];
  assert.strictEqual(matches(['sululta', 'transformer'], fields), true);
  assert.strictEqual(matches(['sululta', 'breaker'], fields), false);
});

test('matches is order-independent and does not span fields', () => {
  assert.strictEqual(matches(['230', 'sululta'], ['Sululta SS', '230']), true);
  assert.strictEqual(matches(['sulu230'], ['Sululta', '230']), false);
});

test('matches returns false when there are no tokens', () => {
  assert.strictEqual(matches([], ['Sululta']), false);
});

test('rank scores title hits above extra-field hits', () => {
  const tokens = ['sululta', '230'];
  const titleHit = rank(tokens, ['Sululta 230kV Line'], ['other']);
  const extraHit = rank(tokens, ['Other Line'], ['Sululta', '230']);
  assert.ok(titleHit > extraHit);
});

test('parseSearchQuery returns the capped raw string and its tokens', () => {
  const parsed = parseSearchQuery('  Sululta 230 Transformer  ');
  assert.strictEqual(parsed.raw, 'Sululta 230 Transformer');
  assert.deepStrictEqual(parsed.tokens, ['sululta', '230', 'transformer']);
});
