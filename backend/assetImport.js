// Pure parsing + template helpers for the asset register bulk import. No DB
// access: the route layer resolves region/substation/line/tower/crew codes,
// enforces command scope, then inserts or updates asset rows.
//
// Assets have no region_id column: region is derived from the structural
// anchor (substation, line or tower). CSV columns therefore reference parent
// records by their human code, not by database id.
const { parseCsv, pick, num, validCoord, parseInfra, firstNonEmpty } = require('./infraImport');

const ASSET_COLUMNS = [
  'asset_id', 'name', 'asset_type', 'sub_type',
  'substation_code', 'line_code', 'tower_code', 'parent_asset_code', 'region_code',
  'latitude', 'longitude', 'km_from', 'km_to',
  'location_type', 'bay', 'manufacturer', 'model', 'serial_number',
  'installation_date', 'commissioned_date', 'condition_rating', 'criticality',
  'lifecycle_status', 'operational_status', 'warranty_expiry',
  'last_maintenance_at', 'next_maintenance_at', 'default_crew_code', 'gps_validated',
  'metadata',
];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

// Sample rows: one substation asset, one line span (km range) and one asset
// anchored to a tower. Tower/POLE rows are intentionally absent — tower
// structures are created and maintained through the tower register.
const ASSET_TEMPLATE = [
  csvRow(ASSET_COLUMNS),
  csvRow(['AST-NE1-001', 'Main Transformer T1', 'TRANSFORMER', '',
    'SS-NE1-101', '', '', '', 'NE1', '', '', '', '',
    'OUTDOOR', 'Bay 1', 'EEU', 'TR-40MVA', 'SN-T1-2026', '2026-01-20', '2026-02-01',
    '8', 'CRITICAL', 'IN_SERVICE', 'OPERATIONAL', '', '', '', 'NE1-Transformer', '0',
    '{"cooling":"ONAN","rating_mva":40}']),
  csvRow(['AST-NE1-002', 'Northport-Meridian 230kV span 1', 'CONDUCTOR_SPAN', '',
    '', 'TL-NE1-201', '', '', 'NE1', '', '', '0', '5',
    'OUTDOOR', '', '', '', '', '', '', '7', 'HIGH', 'IN_SERVICE', 'OPERATIONAL', '', '', '', '', '0',
    '{"conductor":"ACSR 2x630"}']),
  csvRow(['AST-NE1-003', 'Line arrester LA-01', 'LIGHTNING_ARRESTER', '',
    '', '', 'NE1-201-001', '', 'NE1', '', '', '', '',
    'OUTDOOR', '', 'ABB', 'POLIM-D', 'SN-LA-01', '2024-07-01', '2024-07-10',
    '9', 'MEDIUM', 'IN_SERVICE', 'OPERATIONAL', '', '', '', '', '1', '{}']),
].join('\n');

// One record per asset row/Point feature.
function assetRecords(parsed) {
  if (parsed.kind === 'rows') return parsed.rows.map((r) => ({ props: r }));
  return parsed.features.map((f) => ({
    props: { ...f.props, name: pick(f.props, ['name']) || f.name },
    lat: num(f.lat),
    lng: num(f.lng),
  }));
}

module.exports = {
  ASSET_COLUMNS,
  ASSET_TEMPLATE,
  assetRecords,
  parseCsv,
  pick,
  num,
  validCoord,
  parseInfra,
  firstNonEmpty,
};
