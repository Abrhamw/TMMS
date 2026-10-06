'use strict';

const CODES = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  TOO_MANY_REQUESTS: 429,
  INTERNAL: 500,
  SERVICE_UNAVAILABLE: 503,
};

class AppError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.status = CODES[code] || 500;
    this.details = details;
    this.expose = true;
  }
}

function isAppError(err) {
  return err instanceof AppError;
}

const badRequest = (message, details) => new AppError('BAD_REQUEST', message, details);
const validation = (message, details) => new AppError('VALIDATION_ERROR', message, details);
const unauthorized = (message) => new AppError('UNAUTHORIZED', message || 'Unauthorized');
const forbidden = (message) => new AppError('FORBIDDEN', message || 'Forbidden');
const notFound = (message) => new AppError('NOT_FOUND', message || 'Not found');
const conflict = (message, details) => new AppError('CONFLICT', message, details);
const payloadTooLarge = (message) => new AppError('PAYLOAD_TOO_LARGE', message || 'Payload too large');
const tooManyRequests = (message) => new AppError('TOO_MANY_REQUESTS', message || 'Too many requests');
const unavailable = (message) => new AppError('SERVICE_UNAVAILABLE', message || 'Service unavailable');

function errorPayload(err, requestId) {
  const appErr = isAppError(err) ? err : new AppError('INTERNAL', 'Internal server error');
  const body = { error: appErr.message, code: appErr.code };
  if (appErr.details) body.details = appErr.details;
  if (requestId) body.request_id = requestId;
  return body;
}

module.exports = {
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
};
