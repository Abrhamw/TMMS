const { db } = require('./db');

// Preparing a statement on node:sqlite costs a parse/plan every time. Bulk
// paths (imports, list enrichment, reconcile) run the same handful of SQL
// thousands of times, so keep the prepared handles around.
const stmtCache = new Map();
const STMT_CACHE_MAX = 1000;

function prep(sql) {
  let stmt = stmtCache.get(sql);
  if (stmt) return stmt;
  if (stmtCache.size >= STMT_CACHE_MAX) stmtCache.clear();
  stmt = db.prepare(sql);
  stmtCache.set(sql, stmt);
  return stmt;
}

function parseRow(row, jsonCols = []) {
  if (!row) return row;
  const out = { ...row };
  for (const c of jsonCols) {
    // Unwrap JSON columns defensively. Historical writes could double-encode
    // an array/object (JSON.stringify applied to an already-serialized
    // string), so keep parsing while the value is still a string.
    let v = out[c];
    let guard = 0;
    while (typeof v === 'string' && guard < 5) {
      let parsed;
      try {
        parsed = JSON.parse(v);
      } catch (_) {
        break;
      }
      v = parsed;
      guard++;
    }
    out[c] = v;
  }
  return out;
}

function list(table, jsonCols = [], orderBy = 'id') {
  return prep(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all().map((r) => parseRow(r, jsonCols));
}

function get(table, id, jsonCols = []) {
  return parseRow(prep(`SELECT * FROM ${table} WHERE id = ?`).get(id), jsonCols);
}

const columnCache = new Map();

function columns(table) {
  if (columnCache.has(table)) return columnCache.get(table);
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  columnCache.set(table, cols);
  return cols;
}

function cleanRow(table, row, jsonCols = []) {
  const valid = new Set(columns(table));
  const clean = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined || v === null) continue;
    if (!valid.has(k)) continue;
    // Only serialize JSON columns that hold a live value. A caller may already
    // have serialized it (e.g. `route_json: JSON.stringify(coords)`); sending
    // that through JSON.stringify again would store a quoted string and break
    // every reader that expects an array/object.
    clean[k] = jsonCols.includes(k) && typeof v !== 'string' ? JSON.stringify(v) : v;
  }
  return clean;
}

function insertRow(table, row, jsonCols = []) {
  const clean = cleanRow(table, row, jsonCols);
  const cols = Object.keys(clean);
  if (cols.length === 0) throw new Error('No valid columns provided');
  const stmt = prep(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  );
  const res = stmt.run(...cols.map((c) => clean[c]));
  return Number(res.lastInsertRowid);
}

function updateRow(table, id, row, jsonCols = [], revisionCol = null) {
  const clean = cleanRow(table, row, jsonCols);
  delete clean.id;
  if (Object.keys(clean).length === 0) return;
  if (revisionCol && !clean[revisionCol]) {
    clean[revisionCol] = prep(`SELECT ${revisionCol} FROM ${table} WHERE id = ?`).get(id)?.[revisionCol] + 1;
  }
  const sets = Object.keys(clean)
    .map((c) => `${c} = ?`)
    .join(', ');
  prep(`UPDATE ${table} SET ${sets} WHERE id = ?`).run(...Object.values(clean), id);
}

function safeDelete(table, id) {
  const res = prep(`DELETE FROM ${table} WHERE id = ?`).run(id);
  return Number(res.changes) > 0;
}

// Offline writes carry an optional client_ref; a retried request must return
// the row the first attempt created instead of inserting a duplicate.
function byClientRef(table, ref) {
  if (!ref) return null;
  return prep(`SELECT * FROM ${table} WHERE client_ref = ?`).get(String(ref));
}

// node:sqlite's DatabaseSync has no db.transaction() helper, so run a unit of
// work atomically with explicit BEGIN/COMMIT/ROLLBACK. Not reentrant: wrap only
// the outermost unit of work and never call it from inside another withTx.
function withTx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {}
    throw e;
  }
}

function nextCode(prefix, table, col, pad = 3) {
  const row = prep(`SELECT ${col} AS c FROM ${table} ORDER BY ${col} DESC LIMIT 1`).get();
  const n = row ? parseInt(row.c.split('-').pop(), 10) + 1 : 1;
  return `${prefix}-${String(n).padStart(pad, '0')}`;
}

module.exports = { db, prep, parseRow, list, get, insertRow, updateRow, safeDelete, byClientRef, withTx, nextCode };
