const test = require('node:test');
const assert = require('node:assert');

const {
  CODES,
  AppError,
  isAppError,
  errorPayload,
  badRequest,
  validation,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  payloadTooLarge,
  tooManyRequests,
  unavailable,
} = require('../errors');

test('AppError maps codes to http status and is detectable', () => {
  const err = new AppError('NOT_FOUND', 'missing');
  assert.strictEqual(err.status, 404);
  assert.strictEqual(err.code, 'NOT_FOUND');
  assert.strictEqual(err.message, 'missing');
  assert.ok(isAppError(err));
  assert.ok(err instanceof Error);
});

test('AppError defaults unknown codes to 500 and message to code', () => {
  const err = new AppError('SOMETHING_ELSE');
  assert.strictEqual(err.status, 500);
  assert.strictEqual(err.message, 'SOMETHING_ELSE');
});

test('every declared code has an http status', () => {
  for (const [code, status] of Object.entries(CODES)) {
    assert.strictEqual(new AppError(code).status, status);
  }
});

test('errorPayload never exposes unexpected internals', () => {
  const payload = errorPayload(new TypeError('leaky internal detail'), 'req-1');
  assert.deepStrictEqual(payload, { error: 'Internal server error', code: 'INTERNAL', request_id: 'req-1' });
});

test('errorPayload surfaces app errors with details and request id', () => {
  const payload = errorPayload(new AppError('VALIDATION_ERROR', 'Request validation failed', ['a is required']), 'req-2');
  assert.deepStrictEqual(payload, {
    error: 'Request validation failed',
    code: 'VALIDATION_ERROR',
    details: ['a is required'],
    request_id: 'req-2',
  });
});

test('errorPayload omits request id when absent', () => {
  const payload = errorPayload(unauthorized());
  assert.deepStrictEqual(payload, { error: 'Unauthorized', code: 'UNAUTHORIZED' });
});

test('helper constructors build the expected codes', () => {
  assert.strictEqual(badRequest('x').code, 'BAD_REQUEST');
  assert.strictEqual(validation('x').code, 'VALIDATION_ERROR');
  assert.strictEqual(unauthorized().code, 'UNAUTHORIZED');
  assert.strictEqual(forbidden().code, 'FORBIDDEN');
  assert.strictEqual(notFound().code, 'NOT_FOUND');
  assert.strictEqual(conflict('x').code, 'CONFLICT');
  assert.strictEqual(payloadTooLarge().code, 'PAYLOAD_TOO_LARGE');
  assert.strictEqual(tooManyRequests().code, 'TOO_MANY_REQUESTS');
  assert.strictEqual(unavailable().code, 'SERVICE_UNAVAILABLE');
});
