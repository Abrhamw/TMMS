const test = require('node:test');
const assert = require('node:assert');

const { validate, checkField, stripImmutable, IMMUTABLE_FIELDS } = require('../validation');

test('validate applies defaults and returns only declared fields', () => {
  const out = validate(
    {
      name: { type: 'string', required: true },
      active: { type: 'boolean', default: true },
      region: { type: 'integer' },
    },
    { name: 'Alpha', region: '7', extra: 'ignored' }
  );
  assert.deepStrictEqual(out, { name: 'Alpha', active: true, region: 7 });
});

test('validate throws a VALIDATION_ERROR with per-field details', () => {
  assert.throws(
    () => validate({ name: { type: 'string', required: true }, age: { type: 'integer' } }, { age: 'nope' }),
    (err) => {
      assert.strictEqual(err.code, 'VALIDATION_ERROR');
      assert.match(err.message, /validation failed/i);
      assert.deepStrictEqual(err.details.sort(), ['age must be an integer', 'name is required'].sort());
      return true;
    }
  );
});

test('validate rejects unknown keys when asked', () => {
  assert.throws(
    () => validate({ name: { type: 'string' } }, { name: 'a', rogue: 1 }, { rejectUnknown: true }),
    (err) => {
      assert.deepStrictEqual(err.details, ['rogue is not allowed']);
      return true;
    }
  );
});

test('checkField enforces string constraints and trimming', () => {
  const rule = { type: 'string', minLength: 3, maxLength: 5, pattern: /^[a-z]+$/, trim: true };
  assert.deepStrictEqual(checkField('code', rule, '  ab  ').errors, ['code must be at least 3 characters']);
  assert.deepStrictEqual(checkField('code', rule, 'abc').value, 'abc');
  assert.deepStrictEqual(checkField('code', rule, 'A1').errors, ['code must be at least 3 characters', 'code has an invalid format']);
  assert.deepStrictEqual(checkField('code', rule, 'abcdef').errors, ['code must be at most 5 characters']);
});

test('checkField validates email, date, number, enum, min and max', () => {
  assert.deepStrictEqual(checkField('email', { type: 'email' }, ' X@Y.COM ').value, 'x@y.com');
  assert.strictEqual(checkField('email', { type: 'email' }, 'not-an-email').errors.length, 1);
  assert.strictEqual(checkField('when', { type: 'date' }, '2026-10-06').errors.length, 0);
  assert.strictEqual(checkField('when', { type: 'date' }, 'nope').errors.length, 1);
  assert.deepStrictEqual(checkField('n', { type: 'number' }, '1.5').value, 1.5);
  assert.strictEqual(checkField('n', { type: 'integer' }, 1.2).errors.length, 1);
  assert.deepStrictEqual(checkField('p', { type: 'string', enum: ['LOW', 'HIGH'] }, 'MED').errors, ['p must be one of: LOW, HIGH']);
  assert.deepStrictEqual(checkField('p', { type: 'integer', min: 1, max: 5 }, 9).errors, ['p must be <= 5']);
});

test('checkField handles nullable, missing and array items', () => {
  assert.deepStrictEqual(checkField('note', { type: 'string', nullable: true }, null), { value: null, errors: [] });
  assert.deepStrictEqual(checkField('note', { type: 'string' }, undefined).value, undefined);
  const arr = checkField('tags', { type: 'array', of: { type: 'integer' }, maxItems: 2 }, ['1', 'x', '3']);
  assert.deepStrictEqual(arr.value, [1, 3]);
  assert.deepStrictEqual(arr.errors, ['tags[1] must be an integer', 'tags must have at most 2 items']);
});

test('stripImmutable removes server-owned fields and passes through', () => {
  for (const field of IMMUTABLE_FIELDS) {
    const req = { body: { title: 'x', [field]: 'server-value' } };
    let called = false;
    stripImmutable(req, {}, () => { called = true; });
    assert.ok(called);
    assert.strictEqual(req.body[field], undefined);
    assert.strictEqual(req.body.title, 'x');
  }
});

test('stripImmutable tolerates missing and non-object bodies', () => {
  assert.doesNotThrow(() => stripImmutable({ body: null }, {}, () => {}));
  assert.doesNotThrow(() => stripImmutable({ body: [1, 2] }, {}, () => {}));
});
