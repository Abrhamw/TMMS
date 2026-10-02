const zlib = require('node:zlib');

// Dependency-free gzip for dynamic responses. The register endpoints serialise
// multi-megabyte JSON (tower/asset registers, the map payload), so compressing
// the body is the single biggest transfer win. Assets already streamed from disk
// keep their own handling; only text/JSON sent through res.send is compressed.
const MIN_BYTES = 1024;
const COMPRESSIBLE = /json|text|javascript|xml|svg|x-ndjson|csv/i;

function acceptsGzip(req) {
  const header = req.headers['accept-encoding'];
  return typeof header === 'string' && /\bgzip\b/.test(header);
}

module.exports = function gzipMiddleware(req, res, next) {
  const send = res.send.bind(res);
  const canGzip = acceptsGzip(req);
  res.send = function sendCompressed(body) {
    if (body === undefined || body === null) return send(body);
    if (res.statusCode === 204 || res.statusCode === 304) return send(body);
    if (typeof body !== 'string' && !Buffer.isBuffer(body)) return send(body);
    const type = String(res.getHeader('Content-Type') || '');
    if (!COMPRESSIBLE.test(type)) return send(body);
    if (!res.getHeader('Vary')) res.setHeader('Vary', 'Accept-Encoding');
    if (res.getHeader('Content-Encoding') || !canGzip) return send(body);
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (buf.length < MIN_BYTES) return send(body);
    zlib.gzip(buf, (err, gz) => {
      if (err) return send(body);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', String(gz.length));
      res.end(gz);
    });
    return res;
  };
  next();
};
