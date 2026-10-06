'use strict';

const { AppError } = require('./errors');

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function coerceNumber(value, integer) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  if (integer && !Number.isInteger(n)) return NaN;
  return n;
}

function checkField(name, rule, value) {
  const errors = [];
  if (value === null && rule.nullable) return { value: null, errors };
  const present = value !== undefined && value !== null && value !== '';
  if (!present) {
    if (rule.required) return { errors: [`${name} is required`] };
    if ('default' in rule) return { value: rule.default, errors };
    return { value: undefined, errors };
  }

  let out = value;
  switch (rule.type) {
    case 'string': {
      out = String(value);
      if (rule.trim) out = out.trim();
      if (rule.minLength != null && out.length < rule.minLength) errors.push(`${name} must be at least ${rule.minLength} characters`);
      if (rule.maxLength != null && out.length > rule.maxLength) errors.push(`${name} must be at most ${rule.maxLength} characters`);
      if (rule.pattern && !rule.pattern.test(out)) errors.push(`${name} has an invalid format`);
      break;
    }
    case 'email': {
      out = String(value).trim().toLowerCase();
      if (!EMAIL_RE.test(out)) errors.push(`${name} must be a valid email`);
      break;
    }
    case 'date': {
      out = String(value);
      if (Number.isNaN(Date.parse(out))) errors.push(`${name} must be a valid date`);
      break;
    }
    case 'integer': {
      const n = coerceNumber(value, true);
      if (!Number.isInteger(n)) errors.push(`${name} must be an integer`);
      else out = n;
      break;
    }
    case 'number': {
      const n = coerceNumber(value, false);
      if (!Number.isFinite(n)) errors.push(`${name} must be a number`);
      else out = n;
      break;
    }
    case 'boolean': {
      if (typeof value === 'string') out = value === 'true' || value === '1';
      else out = !!value;
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) { errors.push(`${name} must be an array`); break; }
      if (rule.of) {
        out = [];
        for (let i = 0; i < value.length; i += 1) {
          const r = checkField(`${name}[${i}]`, rule.of, value[i]);
          if (r.errors.length) errors.push(...r.errors);
          else if (r.value !== undefined) out.push(r.value);
        }
      } else {
        out = value;
      }
      if (rule.maxItems != null && value.length > rule.maxItems) errors.push(`${name} must have at most ${rule.maxItems} items`);
      break;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) errors.push(`${name} must be an object`);
      break;
    }
    default:
      out = value;
  }

  if (!errors.length && rule.enum && !rule.enum.includes(out)) errors.push(`${name} must be one of: ${rule.enum.join(', ')}`);
  if (!errors.length && rule.min != null && out < rule.min) errors.push(`${name} must be >= ${rule.min}`);
  if (!errors.length && rule.max != null && out > rule.max) errors.push(`${name} must be <= ${rule.max}`);
  return { value: out, errors };
}

function validate(schema, body, opts = {}) {
  const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const out = {};
  const errors = [];
  for (const [name, rule] of Object.entries(schema)) {
    const result = checkField(name, rule, src[name]);
    if (result.errors.length) errors.push(...result.errors);
    else if (result.value !== undefined) out[name] = result.value;
  }
  if (opts.rejectUnknown) {
    for (const key of Object.keys(src)) {
      if (!(key in schema)) errors.push(`${key} is not allowed`);
    }
  }
  if (errors.length) throw new AppError('VALIDATION_ERROR', 'Request validation failed', errors);
  return out;
}

function validateBody(schema, opts = {}) {
  return (req, res, next) => {
    try {
      req.body = validate(schema, req.body, opts);
      next();
    } catch (err) {
      next(err);
    }
  };
}

const IMMUTABLE_FIELDS = ['id', 'revision', 'created_at', 'updated_at'];

function stripImmutable(req, res, next) {
  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const key of IMMUTABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) delete body[key];
    }
  }
  next();
}

module.exports = { validate, validateBody, checkField, stripImmutable, IMMUTABLE_FIELDS };
