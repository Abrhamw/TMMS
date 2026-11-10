const test = require('node:test');
const assert = require('node:assert');
const { tokenize, matches, rank, parseSearchQuery, rowMatchesIntent } = require('../searchEngine');

test('tokenize lowercases, trims, and splits on whitespace', () => {
  assert.deepStrictEqual(tokenize('  Sululta   230  '), ['sululta', '230']);
});

test('tokenize returns an empty list for blank input', () => {
  assert.deepStrictEqual(tokenize(''), []);
  assert.deepStrictEqual(tokenize('   '), []);
  assert.deepStrictEqual(tokenize(null), []);
});

test('tokenize caps the raw query at 200 characters before splitting', () => {
  const raw = `${'alpha '.repeat(40)}omega`;
  const tokens = tokenize(raw);
  assert.ok(tokens.length <= 16);
  assert.ok(!tokens.includes('omega'));
});

test('tokenize keeps at most the first sixteen tokens', () => {
  const tokens = tokenize('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen');
  assert.deepStrictEqual(tokens, [
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
    'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  ]);
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
  assert.deepStrictEqual(parsed.intent.types, ['asset']);
  assert.ok(parsed.intent.assetTypes.includes('TRANSFORMER'));
});

test('parseSearchQuery strips filler words from a statement', () => {
  const parsed = parseSearchQuery('show me towers in Central 1');
  assert.deepStrictEqual(parsed.tokens, ['towers', 'central', '1']);
  assert.deepStrictEqual(parsed.intent.types, ['tower']);
  assert.strictEqual(parsed.intent.mine, false);
});

test('parseSearchQuery treats tasks for me as personal work', () => {
  const parsed = parseSearchQuery('tasks for me');
  assert.deepStrictEqual(parsed.intent.types, ['task']);
  assert.strictEqual(parsed.intent.mine, true);
  assert.deepStrictEqual(parsed.tokens, ['tasks']);
});

test('parseSearchQuery treats my crews as personal', () => {
  const parsed = parseSearchQuery('my crews');
  assert.deepStrictEqual(parsed.intent.types, ['crew']);
  assert.strictEqual(parsed.intent.mine, true);
});

test('parseSearchQuery reads overdue inspections with a relative date', () => {
  const now = new Date('2026-11-06T12:00:00.000Z');
  const parsed = parseSearchQuery('find failed inspections last week', now);
  assert.deepStrictEqual(parsed.tokens, ['inspections']);
  assert.ok(parsed.intent.types.includes('task'));
  assert.deepStrictEqual(parsed.intent.taskTypes, ['INSPECTION']);
  assert.deepStrictEqual(parsed.intent.statuses, ['FAILED']);
  assert.ok(parsed.intent.dateFrom);
  assert.ok(parsed.intent.dateTo);
});

test('parseSearchQuery treats overdue as open work past due', () => {
  const parsed = parseSearchQuery('overdue tasks in sululta');
  assert.deepStrictEqual(parsed.tokens, ['tasks', 'sululta']);
  assert.deepStrictEqual(parsed.intent.types, ['task']);
  assert.strictEqual(parsed.intent.overdue, true);
});

test('rowMatchesIntent filters overdue open tasks', () => {
  const intent = parseSearchQuery('overdue').intent;
  const openPast = { status: 'IN_PROGRESS', due_date: '2000-01-01T00:00:00.000Z' };
  const donePast = { status: 'COMPLETED', due_date: '2000-01-01T00:00:00.000Z' };
  const openFuture = { status: 'ASSIGNED', due_date: '2099-01-01T00:00:00.000Z' };
  assert.strictEqual(rowMatchesIntent('task', openPast, intent), true);
  assert.strictEqual(rowMatchesIntent('task', donePast, intent), false);
  assert.strictEqual(rowMatchesIntent('task', openFuture, intent), false);
});
