const express = require('express');
const { db, list, get, insertRow, updateRow } = require('../util');
const { can, audit } = require('../auth');

const router = express.Router();

const COLS = ['family', 'family_label', 'label', 'asset_type', 'sub_type', 'unit_of_measure', 'location_kind', 'default_location_type', 'attribute_schema', 'default_unit_price', 'active'];

function clean(body) {
  const out = {};
  for (const c of COLS) {
    if (c === 'attribute_schema') {
      if (body[c] != null) out[c] = typeof body[c] === 'string' ? body[c] : JSON.stringify(body[c]);
    } else if (body[c] !== undefined) {
      out[c] = body[c];
    }
  }
  return out;
}

router.get('/asset-catalog', (req, res) => {
  const rows = list('asset_catalog').filter((r) => r.active !== 0)
    .map((r) => ({ id: r.id, family: r.family, family_label: r.family_label, label: r.label, asset_type: r.asset_type, sub_type: r.sub_type, unit_of_measure: r.unit_of_measure, location_kind: r.location_kind, default_location_type: r.default_location_type, default_unit_price: r.default_unit_price }));
  const families = [];
  for (const r of rows) {
    let f = families.find((x) => x.family === r.family);
    if (!f) { f = { family: r.family, family_label: r.family_label, types: [] }; families.push(f); }
    f.types.push(r);
  }
  res.json({ count: rows.length, families });
});

router.post('/asset-catalog', (req, res) => {
  if (!can(req, 'asset:write')) return res.status(403).json({ error: 'Forbidden: requires asset:write' });
  const { family, asset_type, sub_type = '' } = req.body || {};
  if (!family || !asset_type) return res.status(400).json({ error: 'family and asset_type are required' });
  const dup = db.prepare('SELECT id FROM asset_catalog WHERE family = ? AND asset_type = ? AND sub_type = ?').get(family, asset_type, sub_type);
  if (dup) return res.status(400).json({ error: 'Catalog entry already exists' });
  const body = { family, family_label: req.body.family_label || family.replace(/_/g, ' '), label: req.body.label || asset_type.replace(/_/g, ' '), asset_type, sub_type, unit_of_measure: req.body.unit_of_measure || 'EA', location_kind: req.body.location_kind || 'ANY', active: 1, ...clean(req.body) };
  const id = insertRow('asset_catalog', body);
  audit(req.user, 'CREATE', 'asset_catalog', id, { family, asset_type, sub_type });
  res.status(201).json(get('asset_catalog', id));
});

router.put('/asset-catalog/:id', (req, res) => {
  if (!can(req, 'asset:write')) return res.status(403).json({ error: 'Forbidden: requires asset:write' });
  const row = get('asset_catalog', Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Catalog entry not found' });
  const body = clean({ ...row, ...req.body });
  if (body.asset_type) delete body.asset_type;
  if (body.family) delete body.family;
  if (body.sub_type !== undefined && body.sub_type === null) body.sub_type = '';
  updateRow('asset_catalog', row.id, body);
  audit(req.user, 'UPDATE', 'asset_catalog', row.id, req.body);
  res.json(get('asset_catalog', row.id));
});

module.exports = router;
