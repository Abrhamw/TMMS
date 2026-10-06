'use strict';

const ALLOWED_MIME = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['application/pdf', '.pdf'],
]);

function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buf[i] !== bytes[i]) return false;
  }
  return true;
}

function detectMime(buf) {
  if (!buf || !buf.length) return null;
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (buf.length >= 12 && startsWith(buf, [0x52, 0x49, 0x46, 0x46]) &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  return null;
}

function extensionFor(mime) {
  return ALLOWED_MIME.get(mime) || '.bin';
}

function isAllowed(mime) {
  return ALLOWED_MIME.has(mime);
}

module.exports = { ALLOWED_MIME, detectMime, extensionFor, isAllowed };
