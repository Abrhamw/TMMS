const test = require('node:test');
const assert = require('node:assert');

const { SlidingWindowLimiter, rateLimit, loginLimiter } = require('../rateLimit');

function fakeReqRes(ip) {
  const headers = {};
  return {
    req: { ip },
    res: { setHeader: (k, v) => { headers[k] = v; }, headers },
    nextArgs: [],
  };
}

test('limiter allows requests until the window max is exceeded', () => {
  const limiter = new SlidingWindowLimiter({ max: 2, windowMs: 1000, blockBaseMs: 5000 });
  assert.strictEqual(limiter.fail('k', 0), 0);
  assert.strictEqual(limiter.fail('k', 0), 0);
  const retry = limiter.fail('k', 0);
  assert.strictEqual(retry, 5);
  assert.strictEqual(limiter.check('k', 0), 5);
});

test('limiter block grows exponentially and caps out', () => {
  const limiter = new SlidingWindowLimiter({ max: 1, windowMs: 100000, blockBaseMs: 1000, maxBlockMs: 3000 });
  limiter.fail('k', 0);
  assert.strictEqual(limiter.fail('k', 0), 1);
  assert.strictEqual(limiter.fail('k', 0), 2);
  assert.strictEqual(limiter.fail('k', 0), 3);
  assert.strictEqual(limiter.fail('k', 0), 3);
});

test('limiter recovers after the block elapses and on success', () => {
  const limiter = new SlidingWindowLimiter({ max: 1, windowMs: 1000, blockBaseMs: 1000 });
  limiter.fail('k', 0);
  limiter.fail('k', 0);
  assert.strictEqual(limiter.check('k', 0), 1);
  assert.strictEqual(limiter.check('k', 1000), 0);
  limiter.succeed('k');
  assert.strictEqual(limiter.check('k', 1000), 0);
});

test('rateLimit middleware blocks with Retry-After and a typed error', () => {
  const middleware = rateLimit({ max: 1, windowMs: 60000, blockBaseMs: 5000, keyFn: (req) => req.ip });
  const first = fakeReqRes('1.2.3.4');
  let firstErr = 'unset';
  middleware(first.req, first.res, (err) => { firstErr = err; });
  assert.strictEqual(firstErr, undefined);

  const second = fakeReqRes('1.2.3.4');
  let secondErr = 'unset';
  middleware(second.req, second.res, (err) => { secondErr = err; });
  assert.strictEqual(secondErr, undefined);

  const third = fakeReqRes('1.2.3.4');
  let thirdErr;
  middleware(third.req, third.res, (err) => { thirdErr = err; });
  assert.strictEqual(thirdErr.code, 'TOO_MANY_REQUESTS');
  assert.strictEqual(third.res.headers['Retry-After'], '5');
});

test('rateLimit middleware isolates keys and bypasses missing keys', () => {
  const middleware = rateLimit({ max: 1, windowMs: 60000, blockBaseMs: 5000, keyFn: (req) => req.ip });
  middleware(fakeReqRes('a').req, fakeReqRes('a').res, () => {});
  const other = fakeReqRes('b');
  let err = 'unset';
  middleware(other.req, other.res, (e) => { err = e; });
  assert.strictEqual(err, undefined);

  const anon = fakeReqRes(undefined);
  let anonErr = 'unset';
  middleware(anon.req, anon.res, (e) => { anonErr = e; });
  assert.strictEqual(anonErr, undefined);
});

test('loginLimiter is configured for five attempts per fifteen minutes', () => {
  assert.strictEqual(loginLimiter.max, 5);
  assert.strictEqual(loginLimiter.windowMs, 15 * 60 * 1000);
  assert.strictEqual(loginLimiter.blockBaseMs, 30 * 1000);
});
