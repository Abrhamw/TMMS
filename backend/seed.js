const { db } = require('./db');
const { hashPassword } = require('./auth');
const { polygonFromCenter } = require('./geo');
const { seedStandardComponents } = require('./towerStandards');
const { syncLineTowerCount, syncSubstationBayCount } = require('./integrity');
const { buildWorkbookChecklists } = require('./checklistCatalog');

let seq = 0;
function id() {
  return ++seq;
}

function iso(offsetDays, hour = 9) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function makeRoute(aLat, aLng, bLat, bLng, n = 8) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const jitter = Math.sin(i * 1.7) * 0.012;
    pts.push([
      Math.round((aLat + (bLat - aLat) * t + jitter) * 5) / 5,
      Math.round((aLng + (bLng - aLng) * t + jitter * 0.8) * 5) / 5,
    ]);
  }
  return JSON.stringify(pts);
}

function haversine(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s)));
}

function insert(table, cols, row) {
  const placeholders = cols.map(() => '?').join(',');
  const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
  const res = stmt.run(...cols.map((c) => row[c]));
  return Number(res.lastInsertRowid);
}

function seed() {
  const personIds = {};
  const people = [
    ['Alice', 'Morgan', 'MANAGER', 'North East Region Manager', 'rm-ne'],
    ['Bob', 'Chen', 'SUPERVISOR', 'Line Maintenance Supervisor', 'sup-ne'],
    ['Carol', 'Davis', 'PLANNER', 'Maintenance Planner', 'planner-ne'],
    ['Dan', 'Nguyen', 'FIELD_ENGINEER', 'Substation Field Engineer', 'fe-ne'],
    ['Erin', 'Patel', 'DISPATCHER', 'Regional Dispatcher', 'disp-ne'],
    ['Frank', 'White', 'FIELD_CREW', 'Line Crew Leader', 'leader-ne'],
    ['Grace', 'Lee', 'FIELD_CREW', 'Substation Technician', 'tech-ne'],
    ['Hank', 'Brown', 'SAFETY_OFFICER', 'Safety Officer SW', 'so-sw'],
    ['Ivy', 'Garcia', 'REGION_MANAGER', 'South West Region Manager', 'rm-sw'],
    ['Jack', 'Kim', 'FIELD_CREW', 'Emergency Crew Leader', 'leader-sw'],
    ['Karen', 'Owen', 'FIELD_CREW', 'Relay Technician', 'relay-ce'],
    ['Leo', 'Ross', 'PLANNER', 'Central Planner', 'planner-ce'],
  ];
  for (const [fn, ln, role, title, key] of people) {
    const email = `${key}@tmms.example`;
    const existing = db.prepare('SELECT id FROM person WHERE email = ?').get(email);
    if (existing) {
      personIds[key] = existing.id;
      continue;
    }
    const row = {
      first_name: fn,
      last_name: ln,
      role,
      title,
      phone: `+1-555-${1000 + id()}`,
      email,
      active: 1,
    };
    personIds[key] = insert('person', Object.keys(row), row);
  }

  const regionRows = [
    { code: 'NE', name: 'Northport Region', type: 'NORTHERN', center_lat: 35.8, center_lng: -96.55, boundary: 1.6, status: 'ACTIVE', region_manager_person_id: personIds['rm-ne'], contact_phone: '+1-555-1001', contact_email: 'ne@tmms.example', timezone: 'America/Chicago', notes: 'Northern service area' },
    { code: 'SW', name: 'Red Rock Region', type: 'WESTERN', center_lat: 34.15, center_lng: -99.6, boundary: 1.5, status: 'ACTIVE', region_manager_person_id: personIds['rm-sw'], contact_phone: '+1-555-1002', contact_email: 'sw@tmms.example', timezone: 'America/Chicago', notes: 'Western high plains corridor' },
    { code: 'CE', name: 'Cedar Ridge Region', type: 'CENTRAL', center_lat: 35.1, center_lng: -97.95, boundary: 1.4, status: 'ACTIVE', region_manager_person_id: personIds['planner-ce'], contact_phone: '+1-555-1003', contact_email: 'ce@tmms.example', timezone: 'America/Chicago', notes: 'Central interconnect hub' },
  ];
  const regionIds = {};
  for (const r of regionRows) {
    const existing = db.prepare('SELECT id FROM region WHERE code = ?').get(r.code);
    if (existing) {
      regionIds[r.code] = existing.id;
      continue;
    }
    const row = { ...r, boundary_json: JSON.stringify(polygonFromCenter(r.center_lat, r.center_lng, r.boundary * 111320, 14)) };
    regionIds[r.code] = insert('region', Object.keys(row), row);
  }
  for (const [rk, pk, role] of [
    ['NE', 'rm-ne', 'MANAGER'],
    ['NE', 'sup-ne', 'SUPERVISOR'],
    ['NE', 'planner-ne', 'PLANNER'],
    ['NE', 'disp-ne', 'DISPATCHER'],
    ['NE', 'fe-ne', 'FIELD_ENGINEER'],
    ['SW', 'rm-sw', 'MANAGER'],
    ['SW', 'so-sw', 'SAFETY_OFFICER'],
    ['CE', 'planner-ce', 'PLANNER'],
  ]) {
    insert('region_personnel', ['region_id', 'person_id', 'role', 'is_primary'], { region_id: regionIds[rk], person_id: personIds[pk], role, is_primary: 1 });
  }

  const subRows = [
    { substation_id: 'SUB-NE-001', name: 'Northport 220kV', region_id: regionIds.NE, latitude: 35.92, longitude: -96.42, elevation_m: 350, voltage_levels: JSON.stringify(['220kV', '138kV']), substation_type: 'TRANSFORMER', operational_status: 'OPERATIONAL', commissioned_date: '2005-04-18', owner: 'TM Grid Co', bay_count: 8, gps_validated: 1 },
    { substation_id: 'SUB-NE-002', name: 'Meridian 500kV', region_id: regionIds.NE, latitude: 35.68, longitude: -96.71, elevation_m: 340, voltage_levels: JSON.stringify(['500kV', '220kV']), substation_type: 'TRANSFORMER_SWITCHING', operational_status: 'OPERATIONAL', commissioned_date: '2010-09-02', owner: 'TM Grid Co', bay_count: 12, gps_validated: 1 },
    { substation_id: 'SUB-SW-001', name: 'Red Rock 345kV', region_id: regionIds.SW, latitude: 34.32, longitude: -99.42, elevation_m: 610, voltage_levels: JSON.stringify(['345kV', '138kV']), substation_type: 'TRANSFORMER', operational_status: 'OPERATIONAL', commissioned_date: '2002-01-15', owner: 'TM Grid Co', bay_count: 6, gps_validated: 1 },
    { substation_id: 'SUB-SW-002', name: 'Palo Verde 500kV', region_id: regionIds.SW, latitude: 34.02, longitude: -99.78, elevation_m: 630, voltage_levels: JSON.stringify(['500kV']), substation_type: 'SWITCHING', operational_status: 'MAINTENANCE', commissioned_date: '2015-07-30', owner: 'TM Grid Co', bay_count: 9, gps_validated: 0 },
    { substation_id: 'SUB-CE-001', name: 'Clearwater 220kV', region_id: regionIds.CE, latitude: 35.2, longitude: -97.82, elevation_m: 400, voltage_levels: JSON.stringify(['220kV', '69kV']), substation_type: 'TRANSFORMER', operational_status: 'OPERATIONAL', commissioned_date: '2008-11-11', owner: 'TM Grid Co', bay_count: 7, gps_validated: 1 },
    { substation_id: 'SUB-CE-002', name: 'Cedar Ridge 345kV', region_id: regionIds.CE, latitude: 35.04, longitude: -98.14, elevation_m: 390, voltage_levels: JSON.stringify(['345kV', '220kV']), substation_type: 'TRANSFORMER_SWITCHING', operational_status: 'OPERATIONAL', commissioned_date: '2012-03-25', owner: 'TM Grid Co', bay_count: 10, gps_validated: 1 },
  ];
  const subIds = {};
  for (const s of subRows) {
    const existing = db.prepare('SELECT id FROM substation WHERE substation_id = ?').get(s.substation_id);
    if (existing) {
      subIds[s.substation_id] = existing.id;
      continue;
    }
    const row = { ...s, fence_radius_m: 220, boundary_json: JSON.stringify(polygonFromCenter(s.latitude, s.longitude, 220, 10)) };
    subIds[s.substation_id] = insert('substation', Object.keys(row), row);
  }

  const lineRows = [
    { line_id: 'TL-NE-201', name: 'Northport–Meridian 220kV', region_id: regionIds.NE, from_substation_id: subIds['SUB-NE-001'], to_substation_id: subIds['SUB-NE-002'], route_json: makeRoute(35.92, -96.42, 35.68, -96.71, 10), voltage_kv: 220, line_type: 'OVERHEAD', length_km: 42, conductor_type: 'ACSR 954 kcmil', circuit_count: 1, construction_date: '2004-01-01', commissioned_date: '2005-04-18', rating_mva: 700, operational_status: 'ENERGIZED', gps_validated: 1 },
    { line_id: 'TL-SW-101', name: 'Red Rock–Palo Verde 345kV', region_id: regionIds.SW, from_substation_id: subIds['SUB-SW-001'], to_substation_id: subIds['SUB-SW-002'], route_json: makeRoute(34.32, -99.42, 34.02, -99.78, 12), voltage_kv: 345, line_type: 'OVERHEAD', length_km: 52, conductor_type: 'ACSS 1590 kcmil', circuit_count: 1, construction_date: '2001-01-01', commissioned_date: '2002-01-15', rating_mva: 1100, operational_status: 'ENERGIZED', gps_validated: 1 },
    { line_id: 'TL-CE-301', name: 'Clearwater–Cedar Ridge 220kV', region_id: regionIds.CE, from_substation_id: subIds['SUB-CE-001'], to_substation_id: subIds['SUB-CE-002'], route_json: makeRoute(35.2, -97.82, 35.04, -98.14, 10), voltage_kv: 220, line_type: 'OVERHEAD', length_km: 38, conductor_type: 'ACSR 795 kcmil', circuit_count: 1, construction_date: '2007-01-01', commissioned_date: '2008-11-11', rating_mva: 650, operational_status: 'ENERGIZED', gps_validated: 1 },
    { line_id: 'TL-NE-501', name: 'Northport–Palo Verde 500kV', region_id: regionIds.NE, from_substation_id: subIds['SUB-NE-001'], to_substation_id: subIds['SUB-SW-002'], route_json: makeRoute(35.92, -96.42, 34.02, -99.78, 18), voltage_kv: 500, line_type: 'OVERHEAD', length_km: 420, conductor_type: 'ACSS 2490 kcmil', circuit_count: 1, construction_date: '2009-01-01', commissioned_date: '2010-09-02', rating_mva: 1600, operational_status: 'ENERGIZED', gps_validated: 1 },
    { line_id: 'TL-CE-401', name: 'Clearwater–Meridian 345kV', region_id: regionIds.CE, from_substation_id: subIds['SUB-CE-001'], to_substation_id: subIds['SUB-NE-002'], route_json: makeRoute(35.2, -97.82, 35.68, -96.71, 12), voltage_kv: 345, line_type: 'OVERHEAD', length_km: 88, conductor_type: 'ACSR 1113 kcmil', circuit_count: 1, construction_date: '2011-01-01', commissioned_date: '2012-03-25', rating_mva: 1000, operational_status: 'ENERGIZED', gps_validated: 1 },
  ];
  const lineIds = {};
  for (const l of lineRows) {
    const lid = insert('transmission_line', Object.keys(l), l);
    lineIds[l.line_id] = lid;
  }

  // Towers along each line
  const towerTypes = ['SUSPENSION', 'TENSION', 'SUSPENSION', 'ANGLE', 'SUSPENSION', 'TENSION', 'DEAD_END'];
  let t = 0;
  const towerIds = {};
  const towerId = (line, n) => `${line.line_id.replace('TL-', '')}-${String(n).padStart(3, '0')}`;
  for (const l of lineRows) {
    const route = JSON.parse(l.route_json);
    // A line's route runs from its from-substation to its to-substation, so the
    // first and last route points are substation GPS tie-ins, not towers. Sample
    // only the interior vertices: towers start/end at the line's own endpoints.
    const interior = route.slice(1, -1);
    const nTowers = Math.min(interior.length, 7);
    for (let i = 0; i < nTowers; i++) {
      const pt = interior[Math.floor((i / (nTowers - 1 || 1)) * (interior.length - 1))];
      t += 1;
      const tid = insert('tower', ['tower_id', 'line_id', 'tower_number', 'km_marker', 'latitude', 'longitude', 'tower_type', 'tower_material', 'height_m', 'corrosion_rating', 'gps_validated'], {
        tower_id: towerId(l, i + 1),
        line_id: lineIds[l.line_id],
        tower_number: `${l.line_id.split('-')[1]}-${String(i + 1).padStart(3, '0')}`,
        km_marker: Math.round(((i + 1) / nTowers) * l.length_km * 10) / 10,
        latitude: pt[0],
        longitude: pt[1],
        tower_type: towerTypes[i % towerTypes.length],
        tower_material: 'LATTICE_STEEL',
        height_m: l.voltage_kv >= 500 ? 55 : 38,
        corrosion_rating: 6 + (i % 4),
        gps_validated: i !== 2 ? 1 : 0,
      });
      if (!towerIds[l.line_id]) towerIds[l.line_id] = tid;
    }
  }

  // Assets
  const assetRows = [
    { asset_id: 'XFR-NE-001-T1', asset_type: 'TRANSFORMER', substation_id: subIds['SUB-NE-001'], name: 'Northport T1 GSU Transformer', manufacturer: 'ABB', model: 'TRA-220/138-120MVA', serial_number: 'SN-ABB-22011', installation_date: '2005-03-01', commissioned_date: '2005-04-18', latitude: 35.921, longitude: -96.421, condition_rating: 7, criticality: 'CRITICAL', metadata: JSON.stringify({ rating_mva: 120, voltage_ratio: '220/138', vector_group: 'YNd11', oil_volume_l: 42000, cooling_type: 'ONAF' }), gps_validated: 1 },
    { asset_id: 'XFR-SW-001-T1', asset_type: 'TRANSFORMER', substation_id: subIds['SUB-SW-001'], name: 'Red Rock T1 GSU Transformer', manufacturer: 'Siemens', model: 'TRS-345/138-150MVA', serial_number: 'SN-SIE-99102', installation_date: '2001-11-20', commissioned_date: '2002-01-15', latitude: 34.321, longitude: -99.421, condition_rating: 5, criticality: 'CRITICAL', metadata: JSON.stringify({ rating_mva: 150, voltage_ratio: '345/138', vector_group: 'YNd11', oil_volume_l: 51000, cooling_type: 'ONAN' }), gps_validated: 1 },
    { asset_id: 'XFR-CE-001-T1', asset_type: 'TRANSFORMER', substation_id: subIds['SUB-CE-001'], name: 'Clearwater T1 GSU Transformer', manufacturer: 'GE', model: 'TRA-220/69-90MVA', serial_number: 'SN-GE-11203', installation_date: '2008-09-01', commissioned_date: '2008-11-11', latitude: 35.201, longitude: -97.821, condition_rating: 8, criticality: 'HIGH', metadata: JSON.stringify({ rating_mva: 90, voltage_ratio: '220/69', vector_group: 'YNd11', oil_volume_l: 31000, cooling_type: 'ONAF' }), gps_validated: 1 },
    { asset_id: 'BRK-NE-002-B1', asset_type: 'CIRCUIT_BREAKER', substation_id: subIds['SUB-NE-002'], name: 'Meridian 500kV CB Bay 4', manufacturer: 'Hitachi Energy', model: 'HEC-500-63kA', serial_number: 'SN-HE-55001', installation_date: '2010-05-15', commissioned_date: '2010-09-02', latitude: 35.681, longitude: -96.711, condition_rating: 9, criticality: 'HIGH', metadata: JSON.stringify({ interrupting_rating_ka: 63, operating_mechanism: 'SF6', operating_voltage_kv: 500, op_count: 142 }), gps_validated: 1 },
    { asset_id: 'BRK-SW-002-B1', asset_type: 'CIRCUIT_BREAKER', substation_id: subIds['SUB-SW-002'], name: 'Palo Verde 500kV CB Bay 1', manufacturer: 'Hitachi Energy', model: 'HEC-500-50kA', serial_number: 'SN-HE-55002', installation_date: '2015-06-01', commissioned_date: '2015-07-30', latitude: 34.021, longitude: -99.781, condition_rating: 4, criticality: 'HIGH', metadata: JSON.stringify({ interrupting_rating_ka: 50, operating_mechanism: 'SF6', operating_voltage_kv: 500, op_count: 387 }), gps_validated: 0 },
    { asset_id: 'BRK-CE-002-B2', asset_type: 'CIRCUIT_BREAKER', substation_id: subIds['SUB-CE-002'], name: 'Cedar Ridge 345kV CB Bay 3', manufacturer: 'ABB', model: 'HPL-345-40kA', serial_number: 'SN-ABB-34501', installation_date: '2012-01-10', commissioned_date: '2012-03-25', latitude: 35.041, longitude: -98.141, condition_rating: 7, criticality: 'MEDIUM', metadata: JSON.stringify({ interrupting_rating_ka: 40, operating_mechanism: 'SF6', operating_voltage_kv: 345, op_count: 96 }), gps_validated: 1 },
    { asset_id: 'RLY-NE-002-P1', asset_type: 'PROTECTION_RELAY', substation_id: subIds['SUB-NE-002'], name: 'Meridian Distance Relay P1', manufacturer: 'Schweitzer', model: 'SEL-421', serial_number: 'SN-SEL-77812', installation_date: '2010-04-01', commissioned_date: '2010-09-02', latitude: 35.68, longitude: -96.712, condition_rating: 8, criticality: 'CRITICAL', metadata: JSON.stringify({ relay_type: 'DISTANCE', scheme: 'POTT', communication_protocol: 'IEC 61850', relay_firmware_version: 'R114-V0' }), gps_validated: 1 },
    { asset_id: 'RLY-CE-001-D1', asset_type: 'PROTECTION_RELAY', substation_id: subIds['SUB-CE-001'], name: 'Clearwater Diff Relay D1', manufacturer: 'Schweitzer', model: 'SEL-487E', serial_number: 'SN-SEL-90234', installation_date: '2008-08-15', commissioned_date: '2008-11-11', latitude: 35.202, longitude: -97.822, condition_rating: 6, criticality: 'HIGH', metadata: JSON.stringify({ relay_type: 'DIFFERENTIAL', scheme: '87T', communication_protocol: 'Modbus', relay_firmware_version: 'R203-V1' }), gps_validated: 1 },
    { asset_id: 'RTU-SW-001-S1', asset_type: 'SCADA_RTU', substation_id: subIds['SUB-SW-001'], name: 'Red Rock SCADA RTU', manufacturer: 'Schneider', model: 'RTU-8xx', serial_number: 'SN-SCH-44512', installation_date: '2002-01-01', commissioned_date: '2002-01-15', latitude: 34.322, longitude: -99.422, condition_rating: 6, criticality: 'MEDIUM', metadata: JSON.stringify({ protocol: 'DNP3', point_count: 512, firmware_version: '3.2.1' }), gps_validated: 1 },
    { asset_id: 'ARR-NE-001-A1', asset_type: 'ARRESTER', substation_id: subIds['SUB-NE-001'], name: 'Northport 220kV Surge Arrester', manufacturer: 'Cooper', model: 'VARS-220', serial_number: 'SN-COP-55671', installation_date: '2005-02-01', commissioned_date: '2005-04-18', latitude: 35.92, longitude: -96.423, condition_rating: 7, criticality: 'MEDIUM', metadata: JSON.stringify({ rated_voltage_kv: 192 }), gps_validated: 1 },
    { asset_id: 'INS-SP-N201-A', asset_type: 'INSULATOR_STRING', line_id: lineIds['TL-NE-201'], tower_id: null, name: 'N201 Insulator String A', manufacturer: 'NGK', model: 'V-450', serial_number: 'SN-NGK-20011', installation_date: '2004-05-01', commissioned_date: '2005-04-18', latitude: 35.8, longitude: -96.56, condition_rating: 8, criticality: 'LOW', metadata: JSON.stringify({ disc_count: 22 }), gps_validated: 1 },
    { asset_id: 'COND-SP-TL501-A', asset_type: 'CONDUCTOR_SPAN', line_id: lineIds['TL-NE-501'], name: 'TL-NE-501 Span 12 Conductor', manufacturer: 'Southwire', model: 'ACSS-2490', serial_number: 'SN-SW-90123', installation_date: '2009-06-01', commissioned_date: '2010-09-02', latitude: 35.1, longitude: -98.4, condition_rating: 9, criticality: 'MEDIUM', metadata: JSON.stringify({ conductor_type: 'ACSS 2490 kcmil' }), gps_validated: 1 },
    { asset_id: 'BUS-SW-002-B1', asset_type: 'BUSBAR', substation_id: subIds['SUB-SW-002'], name: 'Palo Verde 500kV Main Bus', manufacturer: 'TM Grid Co', model: 'BUS-500', serial_number: 'SN-TM-00451', installation_date: '2015-05-01', commissioned_date: '2015-07-30', latitude: 34.022, longitude: -99.782, condition_rating: 7, criticality: 'HIGH', metadata: JSON.stringify({ busbar_type: 'RIGID', phases: 3 }), gps_validated: 0 },
    { asset_id: 'VT-NE-001-V1', asset_type: 'VT', substation_id: subIds['SUB-NE-001'], name: 'Northport 220kV VT', manufacturer: 'Trench', model: 'VT-220', serial_number: 'SN-TR-33421', installation_date: '2005-02-15', commissioned_date: '2005-04-18', latitude: 35.919, longitude: -96.422, condition_rating: 8, criticality: 'MEDIUM', metadata: JSON.stringify({ ratio: '220000/115' }), gps_validated: 1 },
    { asset_id: 'CT-CE-002-C1', asset_type: 'CT', substation_id: subIds['SUB-CE-002'], name: 'Cedar Ridge 345kV CT', manufacturer: 'Trench', model: 'CT-345', serial_number: 'SN-TR-77812', installation_date: '2012-01-15', commissioned_date: '2012-03-25', latitude: 35.04, longitude: -98.142, condition_rating: 7, criticality: 'MEDIUM', metadata: JSON.stringify({ ratio: '2000/5' }), gps_validated: 1 },
  ];
  const assetIds = {};
  for (const a of assetRows) {
    const defaults = { condition_assessed_at: iso(-30), last_maintenance_at: iso(-90), next_maintenance_at: iso(30), lifecycle_status: 'IN_SERVICE', operational_status: 'OPERATIONAL' };
    assetIds[a.asset_id] = insert('asset', Object.keys({ ...defaults, ...a }), { ...defaults, ...a });
  }

  // Every tower is also registered as an asset (type TOWER) so towers appear in
  // the asset register, health/condition tracking, reports, and geofencing.
  for (const tw of db.prepare('SELECT * FROM tower ORDER BY id').all()) {
    const row = {
      asset_id: `TWR-${tw.tower_id}`,
      asset_type: 'TOWER',
      line_id: tw.line_id,
      tower_id: tw.id,
      name: tw.tower_id,
      latitude: tw.latitude,
      longitude: tw.longitude,
      condition_rating: tw.corrosion_rating,
      condition_assessed_at: iso(-30),
      lifecycle_status: 'IN_SERVICE',
      operational_status: 'OPERATIONAL',
      criticality: 'MEDIUM',
      gps_validated: tw.gps_validated,
      metadata: JSON.stringify({ source: 'tower', tower_type: tw.tower_type, height_m: tw.height_m }),
    };
    insert('asset', Object.keys(row), row);
  }

  // Crews
  const crewRows = [
    { name: 'Northport Line Crew', crew_code: 'CREW-NE-01', crew_type: 'LINE', region_id: regionIds.NE, leader_person_id: personIds['leader-ne'], home_base: 'Northport Depot', status: 'AVAILABLE' },
    { name: 'Northport Substation Crew', crew_code: 'CREW-NE-02', crew_type: 'SUBSTATION', region_id: regionIds.NE, leader_person_id: personIds['tech-ne'], home_base: 'Meridian Yard', status: 'ON_SITE' },
    { name: 'Red Rock Emergency Crew', crew_code: 'CREW-SW-01', crew_type: 'EMERGENCY_RESPONSE', region_id: regionIds.SW, leader_person_id: personIds['leader-sw'], home_base: 'Red Rock Depot', status: 'AVAILABLE' },
    { name: 'Cedar Relay & Protection', crew_code: 'CREW-CE-01', crew_type: 'RELAY_AND_PROTECTION', region_id: regionIds.CE, leader_person_id: personIds['relay-ce'], home_base: 'Clearwater Yard', status: 'AVAILABLE' },
  ];
  const crewIds = {};
  for (const c of crewRows) crewIds[c.crew_code] = insert('crew', Object.keys(c), c);

  const memberRows = [
    ['CREW-NE-01', 'leader-ne', 'CREW_LEADER', 'SENIOR'],
    ['CREW-NE-01', 'rm-ne', 'LINEMAN', 'INTERMEDIATE'],
    ['CREW-NE-02', 'tech-ne', 'CREW_LEADER', 'EXPERT'],
    ['CREW-NE-02', 'fe-ne', 'TECHNICIAN', 'SENIOR'],
    ['CREW-SW-01', 'leader-sw', 'CREW_LEADER', 'EXPERT'],
    ['CREW-SW-01', 'rm-sw', 'SAFETY_WATCH', 'SENIOR'],
    ['CREW-CE-01', 'relay-ce', 'CREW_LEADER', 'EXPERT'],
    ['CREW-CE-01', 'planner-ce', 'TECHNICIAN', 'SENIOR'],
  ];
  for (const [cc, pk, role, skill] of memberRows) {
    insert('crew_member', ['crew_id', 'person_id', 'role', 'skill_level', 'active'], { crew_id: crewIds[cc], person_id: personIds[pk], role, skill_level: skill, active: 1 });
  }

  const certRows = [
    ['leader-ne', 'LIVE_LINE', iso(-800, 8).slice(0, 10), iso(300, 8).slice(0, 10)],
    ['leader-ne', 'HEIGHT_WORK', iso(-500, 8).slice(0, 10), iso(400, 8).slice(0, 10)],
    ['leader-ne', 'FIRST_AID', iso(-200, 8).slice(0, 10), iso(500, 8).slice(0, 10)],
    ['tech-ne', 'SWITCHING_AUTHORITY', iso(-600, 8).slice(0, 10), iso(200, 8).slice(0, 10)],
    ['tech-ne', 'SF6_HANDLING', iso(-300, 8).slice(0, 10), iso(-10, 8).slice(0, 10)],
    ['leader-sw', 'LIVE_LINE', iso(-400, 8).slice(0, 10), iso(400, 8).slice(0, 10)],
    ['leader-sw', 'HVDC_QUALIFIED', iso(-700, 8).slice(0, 10), iso(100, 8).slice(0, 10)],
    ['relay-ce', 'SWITCHING_AUTHORITY', iso(-500, 8).slice(0, 10), iso(250, 8).slice(0, 10)],
    ['relay-ce', 'CONFINED_SPACE', iso(-100, 8).slice(0, 10), iso(600, 8).slice(0, 10)],
    ['rm-ne', 'FIRST_AID', iso(-50, 8).slice(0, 10), iso(600, 8).slice(0, 10)],
  ];
  for (const [pk, cert, from, to] of certRows) {
    insert('certification', ['person_id', 'cert_type', 'issuing_body', 'issued_at', 'expires_at', 'status'], { person_id: personIds[pk], cert_type: cert, issuing_body: 'NERC-Accredited', issued_at: from, expires_at: to, status: new Date(to) > new Date() ? 'VALID' : 'EXPIRED' });
  }

  // Checklist templates + items
  const clTplRows = [
    { name: 'Transformer Annual Inspection', code: 'CL-TR-INSP', category: 'INSPECTION', asset_type: 'TRANSFORMER', task_type: 'INSPECTION', applicable_voltage_kv: null, requires_supervisor_verification: 1, requires_gps_confirmation: 1, estimated_minutes: 120, safety_notes: 'Isolate taps before access. Record oil level.' },
    { name: 'Circuit Breaker Preventive Maintenance', code: 'CL-CB-PM', category: 'PREVENTIVE_MAINTENANCE', asset_type: 'CIRCUIT_BREAKER', task_type: 'PREVENTIVE', applicable_voltage_kv: null, requires_supervisor_verification: 1, requires_gps_confirmation: 0, estimated_minutes: 180, safety_notes: 'SF6 handling qualified crew required.' },
    { name: 'Line Patrol Inspection', code: 'CL-LN-PAT', category: 'INSPECTION', asset_type: null, task_type: 'INSPECTION', applicable_voltage_kv: null, requires_supervisor_verification: 0, requires_gps_confirmation: 1, estimated_minutes: 90, safety_notes: 'Do not approach conductors under load.' },
    { name: 'Tower Structure Inspection', code: 'CL-TW-INSP', category: 'INSPECTION', asset_type: 'TOWER', task_type: 'INSPECTION', applicable_voltage_kv: null, requires_supervisor_verification: 1, requires_gps_confirmation: 1, estimated_minutes: 75, safety_notes: 'Climbing certified crew required; maintain safe clearance from energized conductors.' },
    { name: 'Tower Hardware & Tightening', code: 'CL-TW-TIGHT', category: 'PREVENTIVE_MAINTENANCE', asset_type: 'TOWER', task_type: 'PREVENTIVE', applicable_voltage_kv: null, requires_supervisor_verification: 1, requires_gps_confirmation: 1, estimated_minutes: 120, safety_notes: 'Verify member integrity before torquing; use calibrated torque tools.' },
    { name: 'Tower Corrosion Treatment', code: 'CL-TW-CORR', category: 'CORRECTIVE_MAINTENANCE', asset_type: 'TOWER', task_type: 'CORRECTIVE', applicable_voltage_kv: null, requires_supervisor_verification: 1, requires_gps_confirmation: 1, estimated_minutes: 180, safety_notes: 'Hot-dip galvanizing repair requires specialized PPE and ventilation.' },
    { name: 'Emergency Restoration', code: 'CL-EMR', category: 'EMERGENCY', asset_type: null, task_type: 'EMERGENCY', applicable_voltage_kv: null, requires_supervisor_verification: 1, requires_gps_confirmation: 1, estimated_minutes: 60, safety_notes: 'Confirm de-energized and grounded before approach.' },
  ];
  const clIds = {};
  const clPreExisting = new Set();
  for (const c of clTplRows) {
    const existing = db.prepare('SELECT id FROM checklist_template WHERE code = ?').get(c.code);
    if (existing) {
      clIds[c.code] = existing.id;
      clPreExisting.add(c.code);
    } else {
      clIds[c.code] = insert('checklist_template', Object.keys(c), c);
    }
  }

  const clItems = {
    'CL-TR-INSP': [
      [1, 'Visual', 'Inspect tank, radiators, and welds for leaks or corrosion', 'PASS_FAIL', 1, 1],
      [2, 'Visual', 'Check oil level and color', 'PASS_FAIL', 1, 1],
      [3, 'Instrument', 'Record top oil temperature', 'NUMERIC', 1, '{"min":0,"max":95,"unit":"°C"}'],
      [4, 'Instrument', 'Record winding temperature', 'NUMERIC', 0, '{"min":0,"max":110,"unit":"°C"}'],
      [5, 'Test', 'Dissolved gas analysis result within limits', 'PASS_FAIL', 1, 1],
      [6, 'GPS', 'Confirm transformer GPS position', 'GPS_POINT', 1, 1],
      [7, 'Doc', 'Attach thermographic scan image', 'PHOTO', 0, 1],
    ],
    'CL-CB-PM': [
      [1, 'Visual', 'Inspect SF6 gauge pressure within spec', 'PASS_FAIL', 1, 1],
      [2, 'Mechanical', 'Check operation counter and mechanism wear', 'NUMERIC', 1, '{"min":0,"max":10000,"unit":"ops"}'],
      [3, 'Mechanical', 'Lubricate operating mechanism', 'PASS_FAIL', 1, 0],
      [4, 'Test', 'Contact resistance (micro-ohm) within limits', 'NUMERIC', 1, '{"min":0,"max":50,"unit":"µΩ"}'],
      [5, 'Doc', 'Attach SF6 gas analysis report', 'PHOTO', 0, 0],
    ],
    'CL-LN-PAT': [
      [1, 'Visual', 'Inspect insulators for cracks or flashover marks', 'PASS_FAIL', 1, 0],
      [2, 'Visual', 'Check conductor sag and clearances', 'PASS_FAIL', 1, 0],
      [3, 'Visual', 'Inspect towers for corrosion or tilt', 'PASS_FAIL', 1, 0],
      [4, 'GPS', 'Confirm route waypoint GPS position', 'GPS_POINT', 1, 0],
      [5, 'Doc', 'Attach patrol photos', 'PHOTO', 0, 0],
    ],
    'CL-EMR': [
      [1, 'Safety', 'Confirm line de-energized and grounded', 'PASS_FAIL', 1, 1],
      [2, 'Visual', 'Assess damage severity', 'SELECT', 1, '{"options":["MINOR","MODERATE","SEVERE"]}'],
      [3, 'Work', 'Execute temporary restoration', 'PASS_FAIL', 1, 1],
      [4, 'GPS', 'Confirm incident location', 'GPS_POINT', 1, 1],
    ],
    'CL-TW-INSP': [
      [1, 'Visual', 'Verify tower identification plate matches asset record', 'PASS_FAIL', 1, 0],
      [2, 'Visual', 'Inspect steel members for corrosion, deformation, or missing bolts', 'PASS_FAIL', 1, 0],
      [3, 'Instrument', 'Record corrosion rating (0-10, 10 = new)', 'NUMERIC', 1, '{"min":0,"max":10}'],
      [4, 'Visual', 'Check tower plumb / verticality (no visible tilt)', 'PASS_FAIL', 1, 0],
      [5, 'Visual', 'Inspect footing and anchor bolts for movement or exposure', 'PASS_FAIL', 1, 0],
      [6, 'Visual', 'Check insulators and conductor attachments for damage', 'PASS_FAIL', 1, 0],
      [7, 'Visual', 'Check for vegetation encroachment in tower base clearance', 'PASS_FAIL', 0, 0],
      [8, 'GPS', 'Confirm tower GPS position', 'GPS_POINT', 1, 1],
      [9, 'Doc', 'Attach tower condition photos', 'PHOTO', 0, 0],
    ],
    'CL-TW-TIGHT': [
      [1, 'Mechanical', 'Torque-check crossarm and leg connection bolts', 'PASS_FAIL', 1, 1],
      [2, 'Mechanical', 'Retighten loose nuts and add locking devices', 'PASS_FAIL', 1, 0],
      [3, 'Visual', 'Replace missing or corroded fasteners', 'PASS_FAIL', 1, 0],
      [4, 'Visual', 'Inspect gusset plates and splice joints', 'PASS_FAIL', 1, 0],
      [5, 'Instrument', 'Record torque wrench verification reading', 'NUMERIC', 1, '{"min":0,"max":500,"unit":"N·m"}'],
      [6, 'GPS', 'Confirm tower GPS position', 'GPS_POINT', 1, 1],
    ],
    'CL-TW-CORR': [
      [1, 'Work', 'Prepare surface (wire brush / power tool clean)', 'PASS_FAIL', 1, 0],
      [2, 'Work', 'Apply cold galvanizing compound to exposed steel', 'PASS_FAIL', 1, 0],
      [3, 'Instrument', 'Record coating dry film thickness', 'NUMERIC', 1, '{"min":40,"max":300,"unit":"µm"}'],
      [4, 'Visual', 'Confirm no unprotected bare steel remains', 'PASS_FAIL', 1, 0],
      [5, 'GPS', 'Confirm tower GPS position', 'GPS_POINT', 1, 1],
      [6, 'Doc', 'Attach before/after corrosion photos', 'PHOTO', 0, 0],
    ],
  };
  for (const [code, items] of Object.entries(clItems)) {
    if (clPreExisting.has(code)) continue;
    for (const [seqNo, section, inst, rt, req, crit] of items) {
      insert('checklist_item', ['template_id', 'sequence', 'section', 'instruction', 'response_type', 'required', 'pass_criteria', 'critical_step'], {
        template_id: clIds[code], sequence: seqNo, section, instruction: inst, response_type: rt, required: req, pass_criteria: rt === 'NUMERIC' ? JSON.stringify(JSON.parse(crit)) : null, critical_step: rt === 'NUMERIC' ? 0 : crit,
      });
    }
  }

  // Maintenance schedules
  const schedRows = [
    { schedule_name: 'Transformer Oil Sampling', schedule_code: 'SCH-XFR-OIL', scope_type: 'ASSET_CLASS', asset_type: 'TRANSFORMER', region_id: regionIds.NE, checklist_template_id: clIds['CL-TR-INSP'], responsible_crew_id: crewIds['CREW-NE-02'], frequency: 'QUARTERLY', priority: 'HIGH', lead_time_days: 10, next_due_date: iso(20), instructions: 'Sample all in-service GSU transformers.' },
    { schedule_name: 'Circuit Breaker Annual PM', schedule_code: 'SCH-CB-ANN', scope_type: 'ASSET_CLASS', asset_type: 'CIRCUIT_BREAKER', region_id: regionIds.NE, checklist_template_id: clIds['CL-CB-PM'], responsible_crew_id: crewIds['CREW-NE-02'], frequency: 'ANNUAL', priority: 'MEDIUM', lead_time_days: 14, next_due_date: iso(45), instructions: 'Annual SF6 and mechanism service.' },
    { schedule_name: 'Monthly Line Patrol', schedule_code: 'SCH-LN-PAT', scope_type: 'LINE', region_id: regionIds.NE, checklist_template_id: clIds['CL-LN-PAT'], responsible_crew_id: crewIds['CREW-NE-01'], frequency: 'MONTHLY', priority: 'MEDIUM', lead_time_days: 5, next_due_date: iso(5), instructions: 'Patrol all overhead lines in region.' },
    { schedule_name: 'Substation Weekly Inspection', schedule_code: 'SCH-SUB-WK', scope_type: 'SUBSTATION', region_id: regionIds.NE, checklist_template_id: clIds['CL-LN-PAT'], responsible_crew_id: crewIds['CREW-NE-02'], frequency: 'WEEKLY', priority: 'LOW', lead_time_days: 2, next_due_date: iso(3), instructions: 'Routine substation walk-down.' },
    { schedule_name: 'Relay Functional Test', schedule_code: 'SCH-RLY-TST', scope_type: 'ASSET_CLASS', asset_type: 'PROTECTION_RELAY', region_id: regionIds.CE, checklist_template_id: clIds['CL-CB-PM'], responsible_crew_id: crewIds['CREW-CE-01'], frequency: 'BIENNIAL', priority: 'HIGH', lead_time_days: 30, next_due_date: iso(200), instructions: 'Two-year protection scheme test.' },
    { schedule_name: '500kV CB Quarterly Check', schedule_code: 'SCH-CB-Q', scope_type: 'ASSET', asset_id: null, region_id: regionIds.SW, checklist_template_id: clIds['CL-CB-PM'], responsible_crew_id: crewIds['CREW-SW-01'], frequency: 'QUARTERLY', priority: 'HIGH', lead_time_days: 7, next_due_date: iso(8), instructions: 'Quarterly checks on Palo Verde 500kV breakers.' },
    { schedule_name: 'Tower Structure Inspection', schedule_code: 'SCH-TW-INSP', scope_type: 'LINE_TOWERS', line_id: lineIds['TL-NE-201'], region_id: regionIds.NE, checklist_template_id: clIds['CL-TW-INSP'], responsible_crew_id: crewIds['CREW-NE-01'], frequency: 'SEMI_ANNUAL', priority: 'MEDIUM', lead_time_days: 14, next_due_date: iso(6), instructions: 'Structural inspection of every tower on the line.' },
    { schedule_name: 'Tower Hardware Tightening', schedule_code: 'SCH-TW-TIGHT', scope_type: 'TOWER', tower_id: towerIds['TL-NE-201'], line_id: lineIds['TL-NE-201'], region_id: regionIds.NE, checklist_template_id: clIds['CL-TW-TIGHT'], responsible_crew_id: crewIds['CREW-NE-01'], frequency: 'ANNUAL', priority: 'LOW', lead_time_days: 7, next_due_date: iso(15), instructions: 'Annual torque check on high-tension towers.' },
  ];
  const schedIds = {};
  for (const s of schedRows) schedIds[s.schedule_code] = insert('maintenance_schedule', Object.keys(s), s);

  // Tasks
  const taskRows = [
    { task_number: 'TK-2026-000101', title: 'Emergency: Palo Verde 500kV CB B1 SF6 low pressure alarm', description: 'Low SF6 pressure alarm received from substation RTU. Investigate and top up.', task_type: 'EMERGENCY', priority: 'CRITICAL', status: 'IN_PROGRESS', region_id: regionIds.SW, substation_id: subIds['SUB-SW-002'], asset_id: null, checklist_template_id: clIds['CL-EMR'], crew_id: crewIds['CREW-SW-01'], due_date: iso(0), scheduled_start: iso(0), priority_reason: 'ALARM', source: 'INCIDENT', created_at: iso(-1), updated_at: iso(0) },
    { task_number: 'TK-2026-000102', title: 'Corrective: Red Rock T1 transformer oil leak investigation', description: 'Oil seepage reported at gasket between tank and conservator.', task_type: 'CORRECTIVE', priority: 'HIGH', status: 'PENDING_VERIFICATION', region_id: regionIds.SW, substation_id: subIds['SUB-SW-001'], asset_id: null, checklist_template_id: clIds['CL-TR-INSP'], crew_id: crewIds['CREW-SW-01'], due_date: iso(3), scheduled_start: iso(-1), scheduled_end: iso(0), actual_start: iso(-1), actual_end: iso(0), priority_reason: 'CONDITION', source: 'AUTO_GENERATED_DEFECT', created_at: iso(-6), updated_at: iso(0) },
    { task_number: 'TK-2026-000103', title: 'Preventive: Meridian 500kV CB Bay 4 annual PM', description: 'Annual preventive maintenance per SCH-CB-ANN.', task_type: 'PREVENTIVE', priority: 'MEDIUM', status: 'ASSIGNED', region_id: regionIds.NE, substation_id: subIds['SUB-NE-002'], asset_id: null, checklist_template_id: clIds['CL-CB-PM'], crew_id: crewIds['CREW-NE-02'], due_date: iso(45), priority_reason: 'AGE', source: 'SCHEDULE_GENERATED', created_at: iso(-2), updated_at: iso(-1) },
    { task_number: 'TK-2026-000104', title: 'Inspection: Northport–Meridian 220kV line patrol', description: 'Monthly patrol generated from SCH-LN-PAT.', task_type: 'INSPECTION', priority: 'MEDIUM', status: 'SCHEDULED', region_id: regionIds.NE, line_id: lineIds['TL-NE-201'], checklist_template_id: clIds['CL-LN-PAT'], due_date: iso(5), source: 'SCHEDULE_GENERATED', created_at: iso(0), updated_at: iso(0) },
    { task_number: 'TK-2026-000105', title: 'Corrective: Northport T1 transformer DGA high hydrogen', description: 'Dissolved gas analysis flagged elevated hydrogen. Plan offline oil treatment.', task_type: 'CORRECTIVE', priority: 'HIGH', status: 'ON_HOLD', region_id: regionIds.NE, substation_id: subIds['SUB-NE-001'], asset_id: null, checklist_template_id: clIds['CL-TR-INSP'], crew_id: crewIds['CREW-NE-02'], due_date: iso(12), priority_reason: 'FAULT', source: 'AUTO_GENERATED_DEFECT', created_at: iso(-10), updated_at: iso(-3) },
    { task_number: 'TK-2026-000106', title: 'Inspection: Clearwater substation walk-down', description: 'Weekly substation inspection per SCH-SUB-WK.', task_type: 'INSPECTION', priority: 'LOW', status: 'COMPLETED', region_id: regionIds.CE, substation_id: subIds['SUB-CE-001'], checklist_template_id: clIds['CL-LN-PAT'], crew_id: crewIds['CREW-CE-01'], due_date: iso(3), scheduled_start: iso(-2), scheduled_end: iso(-1), actual_start: iso(-2), actual_end: iso(-1), result: 'PASS', source: 'SCHEDULE_GENERATED', created_at: iso(-8), updated_at: iso(-1) },
    { task_number: 'TK-2026-000107', title: 'Preventive: Relay functional test Cedar Ridge', description: 'Two-year protection relay scheme test.', task_type: 'PREVENTIVE', priority: 'HIGH', status: 'DRAFT', region_id: regionIds.CE, substation_id: subIds['SUB-CE-002'], asset_id: null, checklist_template_id: clIds['CL-CB-PM'], due_date: iso(200), source: 'MANUAL', created_at: iso(0), updated_at: iso(0) },
    { task_number: 'TK-2026-000108', title: 'Corrective: GPS discrepancy at Palo Verde main bus', description: 'GPS validation failed for 500kV main busbar; re-survey required.', task_type: 'CORRECTIVE', priority: 'MEDIUM', status: 'ASSIGNED', region_id: regionIds.SW, substation_id: subIds['SUB-SW-002'], asset_id: null, checklist_template_id: clIds['CL-EMR'], crew_id: crewIds['CREW-SW-01'], due_date: iso(10), priority_reason: 'GIS_DISCREPANCY', source: 'GIS_DISCREPANCY', created_at: iso(-2), updated_at: iso(-1) },
  ];
  for (const t of taskRows) {
    insert('task', Object.keys(t), { ...t, updated_at: t.updated_at || t.created_at });
  }

  // Geofences
  const geofenceRows = [
    { name: 'Northport 220kV Geofence', target_type: 'SUBSTATION', center_lat: 35.92, center_lng: -96.42, radius_m: 150, tolerance_m: 150, is_active: 1, region_id: regionIds.NE },
    { name: 'Palo Verde 500kV Geofence', target_type: 'SUBSTATION', center_lat: 34.02, center_lng: -99.78, radius_m: 180, tolerance_m: 150, is_active: 1, region_id: regionIds.SW },
  ];
  for (const g of geofenceRows) insert('geofence', Object.keys(g), g);

  // GPS validations
  const gpsRows = [
    { target_type: 'SUBSTATION', target_id: subIds['SUB-NE-001'], region_id: regionIds.NE, expected_lat: 35.92, expected_lng: -96.42, measured_lat: 35.9203, measured_lng: -96.4198, accuracy_m: 4, distance_m: 28, tolerance_m: 150, result: 'PASS', inside_geofence: 1, validation_method: 'GPS_DEVICE', validated_by: personIds['leader-ne'], validated_at: iso(-15), notes: 'Verified on-site.' },
    { target_type: 'SUBSTATION', target_id: subIds['SUB-SW-002'], region_id: regionIds.SW, expected_lat: 34.02, expected_lng: -99.78, measured_lat: 34.03, measured_lng: -99.81, accuracy_m: 6, distance_m: 3118, tolerance_m: 150, result: 'FAIL', inside_geofence: 0, validation_method: 'GPS_DEVICE', validated_by: personIds['leader-sw'], validated_at: iso(-3), linked_task_id: null, notes: 'Coordinates recorded far from registered position.' },
    { target_type: 'ASSET', target_id: assetIds['BRK-SW-002-B1'], region_id: regionIds.SW, expected_lat: 34.021, expected_lng: -99.781, measured_lat: 34.0208, measured_lng: -99.7812, accuracy_m: 3, distance_m: 24, tolerance_m: 50, result: 'PASS', inside_geofence: 1, validation_method: 'GPS_DEVICE', validated_by: personIds['leader-sw'], validated_at: iso(-4), notes: 'CB B1 position confirmed.' },
    { target_type: 'TOWER', target_id: towerIds['TL-NE-201'], region_id: regionIds.NE, expected_lat: 35.8, expected_lng: -96.56, measured_lat: 35.802, measured_lng: -96.562, accuracy_m: 5, distance_m: 255, tolerance_m: 20, result: 'FAIL', inside_geofence: 0, validation_method: 'GPS_DEVICE', validated_by: personIds['leader-ne'], validated_at: iso(-8), notes: 'Tower offset from recorded footing.' },
  ];
  for (const g of gpsRows) insert('gps_validation', Object.keys(g), g);

  // Report templates
  const rtRows = [
    { name: 'Maintenance Completion Summary', report_type: 'MAINTENANCE_COMPLETION', description: 'Completed vs overdue maintenance tasks in period.' },
    { name: 'Asset Condition Report', report_type: 'ASSET_CONDITION', description: 'Asset health index and condition by region.' },
    { name: 'Crew Utilization Report', report_type: 'CREW_UTILIZATION', description: 'Crew labor hours vs availability.' },
    { name: 'Outage / Incident Report', report_type: 'OUTAGE_INCIDENT', description: 'Emergency and corrective outage events.' },
    { name: 'Compliance / Audit Report', report_type: 'COMPLIANCE_AUDIT', description: 'Checklist, GPS, and certification compliance.' },
    { name: 'Overdue Task Report', report_type: 'OVERDUE_TASK', description: 'Aged open task backlog.' },
    { name: 'Schedule Adherence Report', report_type: 'SCHEDULE_ADHERENCE', description: 'Schedule generation and completion lag.' },
    { name: 'GPS Validation Coverage', report_type: 'GPS_COVERAGE', description: 'Validation coverage by target type and region.' },
  ];
  for (const r of rtRows) {
    if (!db.prepare('SELECT id FROM report_template WHERE report_type = ?').get(r.report_type)) {
      insert('report_template', Object.keys(r), r);
    }
  }

  console.log(`Seeded database: ${people.length} people, ${regionRows.length} regions, ${subRows.length} substations, ${lineRows.length} lines, ${assetRows.length} assets, ${crewRows.length} crews, ${clTplRows.length} checklist templates, ${schedRows.length} schedules, ${taskRows.length} tasks.`);
}

module.exports = { seed, seedUsers, backfill, ensureOrgHierarchy, ensureStandardChecklists, ensureWorkbookChecklists, ensureReportTemplates, ensureCostDemo, haversine, iso };

// The 13 regional directorates under the Transmission System Operator,
// aligned to the Transmission business-unit order:
// CEO -> Transmission Business Unit (Higher Deputy Executive Officer)
//     -> Transmission & Substation Maintenance Executive
//     -> Transmission System Operator (TSO)
//     -> 13 Regional Directorates
//     -> per region: Substation Maintenance / Transmission Maintenance /
//        Relay, SCADA, Telecom & Control departments with crews under them
//     -> per substation: resident Substation Manager + operations crew
const ETHIOPIA_REGIONS = [
  { code: 'AA', name: 'Addis Ababa Regional Directorate', center_lat: 9.03, center_lng: 38.74 },
  { code: 'OR', name: 'Oromia Regional Directorate (Adama)', center_lat: 8.54, center_lng: 39.27 },
  { code: 'AM', name: 'Amhara Regional Directorate (Bahir Dar)', center_lat: 11.6, center_lng: 37.39 },
  { code: 'TI', name: 'Tigray Regional Directorate (Mekelle)', center_lat: 13.5, center_lng: 39.47 },
  { code: 'AF', name: 'Afar Regional Directorate (Semera)', center_lat: 11.79, center_lng: 41.01 },
  { code: 'SO', name: 'Somali Regional Directorate (Jijiga)', center_lat: 9.35, center_lng: 42.8 },
  { code: 'BN', name: 'Benishangul-Gumuz Regional Directorate (Asosa)', center_lat: 10.07, center_lng: 34.53 },
  { code: 'SN', name: 'SNNP Regional Directorate (Hawassa)', center_lat: 7.05, center_lng: 38.48 },
  { code: 'SI', name: 'Sidama Regional Directorate (Yirgalem)', center_lat: 6.75, center_lng: 38.41 },
  { code: 'GA', name: 'Gambela Regional Directorate', center_lat: 8.25, center_lng: 34.59 },
  { code: 'HR', name: 'Harari Regional Directorate (Harar)', center_lat: 9.31, center_lng: 42.12 },
  { code: 'SW', name: 'South West Ethiopia Regional Directorate (Bonga)', center_lat: 7.27, center_lng: 36.24 },
  { code: 'DD', name: 'Dire Dawa Regional Directorate', center_lat: 9.6, center_lng: 41.87 },
];

const DIRECTOR_NAMES = {
  AA: ['Abebe', 'Tesfaye'], OR: ['Alemayehu', 'Bekele'], AM: ['Mulugeta', 'Ayele'], TI: ['Hagos', 'Gebre'],
  AF: ['Fatuma', 'Ali'], SO: ['Abdirahman', 'Yusuf'], BN: ['Yohannes', 'Tadesse'], SN: ['Samuel', 'Wolde'],
  SI: ['Teguest', 'Worku'], GA: ['Nyakout', 'Tut'], HR: ['Mohammed', 'Abdulahi'], SW: ['Chaltu', 'Gonfa'], DD: ['Bekele', 'Mekonnen'],
};

// Idempotent: builds the full Transmission business-unit org tree, creates the
// 13 regional directorates, department managers, substation managers, crews and
// their login accounts. Safe to run on every boot against an existing DB.
function ensureOrgHierarchy() {
  const unit = (code, name, unitType, parentId, regionId, managerPersonId) => {
    const existing = db.prepare('SELECT id FROM org_unit WHERE unit_code = ?').get(code);
    if (existing) return existing.id;
    return insert('org_unit', ['unit_code', 'name', 'unit_type', 'parent_id', 'region_id', 'manager_person_id', 'sort_order'], {
      unit_code: code, name, unit_type: unitType, parent_id: parentId || null, region_id: regionId || null, manager_person_id: managerPersonId || null, sort_order: 0,
    });
  };
  const ensurePerson = (firstName, lastName, role, title, email, orgUnitId) => {
    const existing = db.prepare('SELECT id FROM person WHERE email = ?').get(email);
    if (existing) {
      if (orgUnitId) db.prepare('UPDATE person SET org_unit_id = ? WHERE id = ?').run(orgUnitId, existing.id);
      return existing.id;
    }
    return insert('person', ['first_name', 'last_name', 'role', 'title', 'phone', 'email', 'active', 'org_unit_id'], {
      first_name: firstName, last_name: lastName, role, title, phone: `+251-9${String(10000000 + Math.floor(Math.random() * 89999999))}`, email, active: 1, org_unit_id: orgUnitId || null,
    });
  };
  const ensureUser = (username, password, role, regionId, personId) => {
    const existing = db.prepare('SELECT id FROM user WHERE username = ?').get(username);
    if (existing) return;
    insert('user', ['username', 'password_hash', 'person_id', 'role', 'region_id', 'active', 'created_at'], {
      username, password_hash: hashPassword(password), person_id: personId, role, region_id: regionId, active: 1, created_at: new Date().toISOString(),
    });
  };
  const ensureRegion = (r) => {
    const existing = db.prepare('SELECT id FROM region WHERE code = ?').get(r.code);
    if (existing) return existing.id;
    const row = {
      code: r.code, name: r.name, type: 'DIRECTORATE',
      center_lat: r.center_lat, center_lng: r.center_lng, boundary: 1.5, status: 'ACTIVE',
      region_manager_person_id: null, contact_email: `${r.code.toLowerCase()}@tmms.example`,
      timezone: 'Africa/Addis_Ababa', notes: 'Regional directorate under TSO',
      boundary_json: JSON.stringify(polygonFromCenter(r.center_lat, r.center_lng, 1.5 * 111320, 14)),
    };
    return insert('region', Object.keys(row), row);
  };
  const ensureCrew = (name, code, crewType, regionId, leaderPersonId, homeBase) => {
    const existing = db.prepare('SELECT id FROM crew WHERE crew_code = ?').get(code);
    const cid = existing ? existing.id : insert('crew', ['name', 'crew_code', 'crew_type', 'region_id', 'leader_person_id', 'home_base', 'status'], {
      name, crew_code: code, crew_type: crewType, region_id: regionId, leader_person_id: leaderPersonId, home_base: homeBase || 'Regional Depot', status: 'AVAILABLE',
    });
    const member = leaderPersonId && db.prepare('SELECT id FROM crew_member WHERE crew_id = ? AND person_id = ?').get(cid, leaderPersonId);
    if (!member && leaderPersonId) insert('crew_member', ['crew_id', 'person_id', 'role', 'skill_level', 'active'], { crew_id: cid, person_id: leaderPersonId, role: 'CREW_LEADER', skill_level: 'SENIOR', active: 1 });
    return cid;
  };

  const ceo = unit('HQ-CEO', 'Chief Executive Officer', 'CORPORATE', null, null, null);
  const tbu = unit('BU-TBU', 'Transmission Business Unit (Higher Deputy Executive Officer)', 'BUSINESS_UNIT', ceo, null, null);
  const maintExec = unit('DIV-MAINT-EXEC', 'Transmission & Substation Maintenance Executive', 'DIVISION', tbu, null, null);
  const tso = unit('DIV-TSO', 'Transmission System Operator', 'DIVISION', tbu, null, null);

  // Executive leadership login accounts (global scope, task-workflow operators).
  const execs = [
    ['ceo', 'Executive@123', 'EXECUTIVE', 'Chief', 'Executive Officer', 'Chief Executive Officer', ceo, 'ceo@tmms.example'],
    ['exec.maint', 'Executive@123', 'EXECUTIVE', 'Mulugeta', 'Tadesse', 'Transmission & Substation Maintenance Executive', maintExec, 'exec.maint@tmms.example'],
    ['exec.tso', 'Executive@123', 'EXECUTIVE', 'Lidya', 'Mekonnen', 'Transmission System Operator', tso, 'exec.tso@tmms.example'],
  ];
  for (const [uname, upass, urole, fn, ln, title, unitId, email] of execs) {
    if (db.prepare('SELECT id FROM user WHERE username = ?').get(uname)) continue;
    const pid = ensurePerson(fn, ln, urole, title, email, unitId);
    db.prepare('UPDATE org_unit SET manager_person_id = ? WHERE id = ? AND manager_person_id IS NULL').run(pid, unitId);
    ensureUser(uname, upass, urole, null, pid);
  }

  for (const r of ETHIOPIA_REGIONS) {
    const regionId = ensureRegion(r);
    const [df, dl] = DIRECTOR_NAMES[r.code] || [r.code, 'Director'];
    const dirEmail = `director.${r.code.toLowerCase()}@tmms.example`;
    const dir = ensurePerson(df, dl, 'REGION_DIRECTOR', `Region Director — ${r.name}`, dirEmail, null);
    db.prepare('UPDATE region SET region_manager_person_id = ? WHERE id = ?').run(dir, regionId);
    const dirUnit = unit(`DIR-${r.code}`, r.name, 'REGION_DIRECTORATE', tso, regionId, dir);
    db.prepare('UPDATE person SET org_unit_id = ? WHERE id = ?').run(dirUnit, dir);
    if (!db.prepare('SELECT id FROM region_personnel WHERE region_id = ? AND person_id = ?').get(regionId, dir)) {
      insert('region_personnel', ['region_id', 'person_id', 'role', 'is_primary'], { region_id: regionId, person_id: dir, role: 'REGION_DIRECTOR', is_primary: 1 });
    }
    ensureUser(`director.${r.code.toLowerCase()}`, 'Region@123', 'REGION_DIRECTOR', regionId, dir);

    const depts = [
      ['SM', 'SUBSTATION_MAINTENANCE', 'Substation Maintenance', 'SUBSTATION_MANAGER', 'SubMgr@123'],
      ['TM', 'TRANSMISSION_MAINTENANCE', 'Transmission Maintenance', 'TRANSMISSION_MANAGER', 'TransMgr@123'],
      ['RS', 'RELAY_SCADA_TELECOM', 'Relay / SCADA / Telecom & Control', 'RELAY_SCADA_MANAGER', 'RelayMgr@123'],
    ];
    for (const [suffix, utype, dname, drole, dpass] of depts) {
      const dUnit = unit(`DEPT-${r.code}-${suffix}`, `${dname} — ${r.name}`, utype, dirUnit, regionId, null);
      const mgr = ensurePerson(`${dname} Manager`, r.name, drole, `${dname} Manager — ${r.name}`, `${suffix.toLowerCase()}.${r.code.toLowerCase()}@tmms.example`, dUnit);
      db.prepare('UPDATE org_unit SET manager_person_id = ? WHERE id = ?').run(mgr, dUnit);
      if (!db.prepare('SELECT id FROM region_personnel WHERE region_id = ? AND person_id = ?').get(regionId, mgr)) {
        insert('region_personnel', ['region_id', 'person_id', 'role', 'is_primary'], { region_id: regionId, person_id: mgr, role: drole, is_primary: 0 });
      }
      ensureCrew(`${dname} Crew — ${r.name}`, `CREW-${r.code}-${suffix}`, utype, regionId, mgr, null);
      ensureUser(`${suffix.toLowerCase()}.${r.code.toLowerCase()}`, dpass, drole, regionId, mgr);
    }
  }

  // Resident substation managers + operations & maintenance crews at each substation.
  for (const s of db.prepare('SELECT * FROM substation').all()) {
    const regionId = s.region_id;
    const parent = db.prepare("SELECT id FROM org_unit WHERE unit_type = 'SUBSTATION_MAINTENANCE' AND region_id = ? LIMIT 1").get(regionId);
    const parentId = parent ? parent.id : tso;
    const code = `SUB-UNIT-${s.substation_id}`;
    const sUnit = unit(code, `Substation Management — ${s.name}`, 'SUBSTATION_UNIT', parentId, regionId, null);
    const mgr = ensurePerson('Substation', s.name, 'SUBSTATION_MANAGER', `Substation Manager — ${s.name}`, `submgr.${s.substation_id.toLowerCase()}@tmms.example`, sUnit);
    db.prepare('UPDATE org_unit SET manager_person_id = ? WHERE id = ?').run(mgr, sUnit);
    ensureCrew(`Substation Ops & Maint — ${s.name}`, `CREW-SO-${s.substation_id}`, 'SUBSTATION_OPERATIONS', regionId, mgr, s.name);
    ensureUser(`submgr.${s.substation_id.toLowerCase()}`, 'SubMgr@123', 'SUBSTATION_MANAGER', regionId, mgr);
  }
}

// Standard industry checklists for the full substation + tower/line asset set.
// Admin-only editing; this only ensures the base standard templates exist.
function ensureStandardChecklists() {
  const templates = [
    { code: 'CL-DIS-INSP', name: 'Disconnector (Isolator) Inspection', category: 'INSPECTION', asset_type: 'DISCONNECTOR', task_type: 'INSPECTION', requires_gps_confirmation: 1, estimated_minutes: 75, safety_notes: 'Verify position indication; never operate under load.' },
    { code: 'CL-GIS-INSP', name: 'GIS / Indoor Switchgear Inspection', category: 'INSPECTION', asset_type: 'GIS', task_type: 'INSPECTION', requires_gps_confirmation: 1, estimated_minutes: 90, safety_notes: 'Check SF6 density and gas leakage before access.' },
    { code: 'CL-BAT-PM', name: 'Substation Battery & Charger Preventive Maintenance', category: 'PREVENTIVE_MAINTENANCE', asset_type: 'BATTERY_BANK', task_type: 'PREVENTIVE', requires_gps_confirmation: 1, estimated_minutes: 90, safety_notes: 'Ventilation required; PPE for acid handling.' },
    { code: 'CL-RLY-TST', name: 'Protection Relay Functional Test', category: 'TESTING', asset_type: 'PROTECTION_RELAY', task_type: 'TESTING', requires_gps_confirmation: 1, estimated_minutes: 240, safety_notes: 'Coordination with control room; isolate trip circuits during test.' },
    { code: 'CL-SCADA-PM', name: 'SCADA / RTU / Telecom & Control Check', category: 'PREVENTIVE_MAINTENANCE', asset_type: 'SCADA_RTU', task_type: 'PREVENTIVE', requires_gps_confirmation: 1, estimated_minutes: 120, safety_notes: 'Verify redundant communication paths before maintenance.' },
  ];
  const items = {
    'CL-DIS-INSP': [
      [1, 'Visual', 'Inspect blades, contacts and arcing horns for wear', 'PASS_FAIL', 1, 1],
      [2, 'Mechanical', 'Lubricate pivot and motor mechanism', 'PASS_FAIL', 1, 0],
      [3, 'Instrument', 'Record contact resistance (micro-ohm)', 'NUMERIC', 1, '{"min":0,"max":100,"unit":"µΩ"}'],
      [4, 'Test', 'Operate open/close and verify position indication', 'PASS_FAIL', 1, 0],
      [5, 'GPS', 'Confirm disconnector installed-position GPS', 'GPS_POINT', 1, 1],
    ],
    'CL-GIS-INSP': [
      [1, 'Visual', 'Check SF6 density gauges on all compartments', 'PASS_FAIL', 1, 1],
      [2, 'Test', 'Gas leakage test / sniffer survey on flanges', 'PASS_FAIL', 1, 0],
      [3, 'Instrument', 'Record SF6 pressure per compartment', 'NUMERIC', 1, '{"min":0,"max":10,"unit":"bar"}'],
      [4, 'Mechanical', 'Check local/remote selector and interlocks', 'PASS_FAIL', 1, 0],
      [5, 'GPS', 'Confirm GIS bay installed-position GPS', 'GPS_POINT', 1, 1],
    ],
    'CL-BAT-PM': [
      [1, 'Instrument', 'Record battery bank float voltage', 'NUMERIC', 1, '{"min":120,"max":140,"unit":"V"}'],
      [2, 'Instrument', 'Record electrolyte specific gravity', 'NUMERIC', 1, '{"min":1.18,"max":1.3,"unit":"sg"}'],
      [3, 'Test', 'Load test result within specification', 'PASS_FAIL', 1, 0],
      [4, 'Visual', 'Inspect for corrosion, swelling and vent blockage', 'PASS_FAIL', 1, 0],
      [5, 'GPS', 'Confirm battery room / rack GPS position', 'GPS_POINT', 1, 1],
    ],
    'CL-RLY-TST': [
      [1, 'Test', 'Pickup and drop-out current/timing within spec', 'PASS_FAIL', 1, 1],
      [2, 'Test', 'Trip circuit integrity and breaker co-ordination', 'PASS_FAIL', 1, 1],
      [3, 'Instrument', 'Record relay firmware version', 'NUMERIC', 1, '{"min":1,"max":999,"unit":"ver"}'],
      [4, 'Test', 'Verify settings against protection coordination study', 'PASS_FAIL', 1, 0],
      [5, 'GPS', 'Confirm relay panel installed-position GPS', 'GPS_POINT', 1, 1],
    ],
    'CL-SCADA-PM': [
      [1, 'Test', 'RTU/SCADA communication link redundancy verified', 'PASS_FAIL', 1, 0],
      [2, 'Test', 'Point-to-point telemetry accuracy check', 'PASS_FAIL', 1, 0],
      [3, 'Instrument', 'Record firmware version', 'NUMERIC', 1, '{"min":1,"max":999,"unit":"ver"}'],
      [4, 'Visual', 'Inspect antenna, cables and power supply', 'PASS_FAIL', 1, 0],
      [5, 'GPS', 'Confirm RTU/panel installed-position GPS', 'GPS_POINT', 1, 1],
    ],
  };
  for (const c of templates) {
    const existing = db.prepare('SELECT id FROM checklist_template WHERE code = ?').get(c.code);
    const tplId = existing ? existing.id : insert('checklist_template', ['name', 'code', 'category', 'asset_type', 'task_type', 'applicable_voltage_kv', 'version', 'status', 'is_mandatory', 'requires_supervisor_verification', 'requires_gps_confirmation', 'estimated_minutes', 'safety_notes', 'revision'], {
      name: c.name, code: c.code, category: c.category, asset_type: c.asset_type, task_type: c.task_type, applicable_voltage_kv: null, version: 1, status: 'ACTIVE', is_mandatory: 0, requires_supervisor_verification: 1, requires_gps_confirmation: c.requires_gps_confirmation, estimated_minutes: c.estimated_minutes, safety_notes: c.safety_notes, revision: 1,
    });
    const hasItems = db.prepare('SELECT COUNT(*) c FROM checklist_item WHERE template_id = ?').get(tplId).c;
    if (hasItems === 0) {
      for (const [seqNo, section, inst, rt, req, crit] of items[c.code]) {
        insert('checklist_item', ['template_id', 'sequence', 'section', 'instruction', 'response_type', 'required', 'pass_criteria', 'critical_step'], {
          template_id: tplId, sequence: seqNo, section, instruction: inst, response_type: rt, required: req, pass_criteria: rt === 'NUMERIC' ? JSON.stringify(JSON.parse(crit)) : null, critical_step: rt === 'NUMERIC' ? 0 : crit,
        });
      }
    }
  }
}

// Import the checklists triangulated from the Substation Complete Asset
// Inspection & Maintenance workbook. Idempotent: templates are keyed by code.
// When the catalog revision changes the template metadata is refreshed and its
// items are re-synced in place (extra rows removed only when the list shrinks).
const WORKBOOK_ITEM_COLS = ['template_id', 'sequence', 'section', 'instruction', 'response_type', 'required', 'pass_criteria', 'critical_step', 'test_equipment'];
const WORKBOOK_TPL_COLS = ['name', 'code', 'category', 'asset_type', 'task_type', 'applicable_voltage_kv', 'version', 'status', 'is_mandatory', 'requires_supervisor_verification', 'requires_gps_confirmation', 'estimated_minutes', 'safety_notes', 'materials', 'required_personnel', 'revision'];

function ensureWorkbookChecklists() {
  // Retire checklists superseded by the workbook catalogue. Unreferenced
  // templates are removed; if a task or schedule still points at one it is
  // archived instead so the FK stays valid. Covers the pre-split combined
  // "Instrument Transformers (CT/VT/CVT)" templates, the legacy line/tower demo
  // templates, and the per-stream transmission-line templates now consolidated
  // into one checklist per asset family.
  for (const code of [
    'CL-WB-IT-INSP-Q', 'CL-WB-IT-PREV-3Y', 'CL-WB-IT-CBM-3Y',
    'CL-LN-PAT', 'CL-TW-INSP', 'CL-TW-TIGHT', 'CL-TW-CORR',
    'CL-WB-TWR-INSP-3Y', 'CL-WB-TWR-CBM-A', 'CL-WB-TWR-PREV-3Y',
    'CL-WB-FND-PREV-AN',
    'CL-WB-LINS-PREV-3Y', 'CL-WB-LINS-PREV-AN',
    'CL-WB-LCON-CBM-A', 'CL-WB-LCON-PREV-AN', 'CL-WB-LCON-PREV-3Y', 'CL-WB-LCON-PREV-A',
    'CL-WB-FOJB-PREV-A', 'CL-WB-FOJB-INSP-Q',
    'CL-WB-VEG-PREV-A',
    'CL-WB-GRD-PREV-5Y', 'CL-WB-GRD-CBM-A',
  ]) {
    const t = db.prepare('SELECT id FROM checklist_template WHERE code = ?').get(code);
    if (!t) continue;
    const used = db.prepare('SELECT COUNT(*) c FROM task WHERE checklist_template_id = ?').get(t.id).c
      + db.prepare('SELECT COUNT(*) c FROM maintenance_schedule WHERE checklist_template_id = ?').get(t.id).c;
    if (used) {
      db.prepare("UPDATE checklist_template SET status = 'ARCHIVED' WHERE id = ?").run(t.id);
      continue;
    }
    db.prepare('DELETE FROM checklist_execution WHERE template_id = ?').run(t.id);
    db.prepare('DELETE FROM checklist_item WHERE template_id = ?').run(t.id);
    db.prepare('DELETE FROM checklist_template WHERE id = ?').run(t.id);
  }
  for (const c of buildWorkbookChecklists()) {
    const existing = db.prepare('SELECT id, revision FROM checklist_template WHERE code = ?').get(c.code);
    if (!existing) {
      const tplId = insert('checklist_template', WORKBOOK_TPL_COLS, {
        name: c.name, code: c.code, category: c.category, asset_type: c.asset_type, task_type: c.task_type, applicable_voltage_kv: c.applicable_voltage_kv, version: 1, status: 'ACTIVE', is_mandatory: 0, requires_supervisor_verification: c.requires_supervisor_verification, requires_gps_confirmation: c.requires_gps_confirmation, estimated_minutes: c.estimated_minutes, safety_notes: c.safety_notes, materials: c.materials, required_personnel: c.required_personnel, revision: c.revision,
      });
      for (const it of c.items) insert('checklist_item', WORKBOOK_ITEM_COLS, { ...it, template_id: tplId });
      continue;
    }
    const oldItems = db.prepare('SELECT id FROM checklist_item WHERE template_id = ? ORDER BY sequence, id').all(existing.id);
    if (Number(existing.revision) === Number(c.revision) && oldItems.length === c.items.length) continue;
    db.prepare(`UPDATE checklist_template SET name = ?, category = ?, asset_type = ?, task_type = ?, applicable_voltage_kv = ?, status = 'ACTIVE', is_mandatory = 0, requires_supervisor_verification = ?, requires_gps_confirmation = ?, estimated_minutes = ?, safety_notes = ?, materials = ?, required_personnel = ?, revision = ? WHERE id = ?`)
      .run(c.name, c.category, c.asset_type, c.task_type, c.applicable_voltage_kv, c.requires_supervisor_verification, c.requires_gps_confirmation, c.estimated_minutes, c.safety_notes, c.materials, c.required_personnel, c.revision, existing.id);
    c.items.forEach((it, idx) => {
      if (oldItems[idx]) {
        db.prepare('UPDATE checklist_item SET sequence = ?, section = ?, instruction = ?, response_type = ?, required = ?, pass_criteria = ?, critical_step = ?, test_equipment = ? WHERE id = ?')
          .run(it.sequence, it.section, it.instruction, it.response_type, it.required, it.pass_criteria, it.critical_step, it.test_equipment, oldItems[idx].id);
      } else {
        insert('checklist_item', WORKBOOK_ITEM_COLS, { ...it, template_id: existing.id });
      }
    });
    for (let i = c.items.length; i < oldItems.length; i++) {
      db.prepare('DELETE FROM checklist_item WHERE id = ?').run(oldItems[i].id);
    }
  }
}

// Idempotent upgrade of an already-seeded database:
//  - region boundaries (polygon boundary_json from center + radius)
//  - substation yard boundaries (boundary_json polygon + fence_radius_m)
//  - one TOWER asset per tower (so towers are full assets)

// Idempotently seed report templates for the deep-detail document reports so
// they appear in the Reports page alongside the original eight.
function ensureReportTemplates() {
  const rows = [
    { name: 'Asset Detail Document', report_type: 'ASSET_DETAIL', description: 'Full per-asset record, condition, history, checklist executions, GPS and open tasks.' },
    { name: 'Crew Detail Document', report_type: 'CREW_DETAIL', description: 'Full per-crew roster, certifications, task history and utilization.' },
    { name: 'Task Detail Document', report_type: 'TASK_DETAIL', description: 'Single task record: who performed it, executed checklist, findings, photos and verification.' },
    { name: 'Line Detail Document', report_type: 'LINE_DETAIL', description: 'Single transmission line: towers, assets, related maintenance tasks, executions and GPS coverage.' },
    { name: 'Asset Valuation Report', report_type: 'ASSET_VALUATION', description: 'Replacement cost (RCN) and condition-adjusted value of the registered population, by region, family and type.' },
    { name: 'Maintenance Cost Report', report_type: 'MAINTENANCE_COST', description: 'Recorded maintenance spend over a period, by region, asset and event type.' },
    { name: 'Crew Readiness Report', report_type: 'CREW_READINESS', description: 'Per-crew dispatch readiness: roster, certification coverage, unmet skill/cert requirements and KPIs.' },
    { name: 'Person Performance Report', report_type: 'PERSON_PERFORMANCE', description: 'Per-person execution KPIs: completed work, on-time rate, findings and GPS violations.' },
  ];
  for (const r of rows) {
    if (!db.prepare('SELECT id FROM report_template WHERE report_type = ?').get(r.report_type)) {
      insert('report_template', Object.keys(r), r);
    }
  }
}

// Idempotent demo maintenance spend on the C1 demo register assets so the
// maintenance-cost views/reports show believable data in a clean database.
function ensureCostDemo() {
  const demo = db.prepare("SELECT id, asset_id FROM asset WHERE asset_id LIKE 'DEMO-C1-%'").all();
  const byCode = new Map(demo.map((d) => [d.asset_id, d.id]));
  const put = (code, event_type, monthsAgo, cost, summary) => {
    const id = byCode.get(code);
    if (!id) return 0;
    const exists = db.prepare('SELECT id FROM asset_maintenance_event WHERE asset_id = ? AND work_summary = ?').get(id, summary);
    if (exists) return 0;
    insert('asset_maintenance_event', ['asset_id', 'event_type', 'performed_at', 'work_summary', 'cost'], {
      asset_id: id,
      event_type,
      performed_at: new Date(Date.now() - monthsAgo * 30 * 864e5).toISOString(),
      work_summary: summary,
      cost,
    });
    return 1;
  };
  let n = 0;
  n += put('DEMO-C1-HV-01', 'CORRECTIVE', 10, 42000, '[demo-cost] Transformer oil reclamation & gasket replacement');
  n += put('DEMO-C1-HV-01', 'PREVENTIVE', 3, 15000, '[demo-cost] Annual transformer preventive maintenance');
  n += put('DEMO-C1-CP-01', 'PREVENTIVE', 5, 950, '[demo-cost] Relay scheme functional test');
  n += put('DEMO-C1-RTU-01', 'CORRECTIVE', 7, 2200, '[demo-cost] RTU power supply card replacement');
  n += put('DEMO-C1-DC-01', 'CORRECTIVE', 8, 6800, '[demo-cost] Battery bank cell replacement');
  n += put('DEMO-C1-AUX-01', 'PREVENTIVE', 6, 1200, '[demo-cost] Auxiliary transformer servicing');
  n += put('DEMO-C1-MV-01', 'CORRECTIVE', 2, 5400, '[demo-cost] MV switchgear contact overhaul');
  n += put('DEMO-C1-CP-02', 'INSPECTION', 1, 300, '[demo-cost] Metering accuracy verification');
  if (n > 0) console.log(`[costDemo] added ${n} cost-carrying maintenance event(s)`);
  return n;
}

function backfill() {
  const regions = db.prepare('SELECT * FROM region').all();
  const setRegion = db.prepare('UPDATE region SET boundary_json = ? WHERE id = ?');
  for (const r of regions) {
    if (r.boundary_json) continue;
    setRegion.run(JSON.stringify(polygonFromCenter(r.center_lat, r.center_lng, (r.boundary || 1.5) * 111320, 14)), r.id);
  }

  const subs = db.prepare('SELECT * FROM substation').all();
  const setSub = db.prepare('UPDATE substation SET boundary_json = ?, fence_radius_m = ? WHERE id = ?');
  for (const s of subs) {
    if (s.boundary_json) continue;
    setSub.run(JSON.stringify(polygonFromCenter(s.latitude, s.longitude, s.fence_radius_m || 220, 10)), s.fence_radius_m || 220, s.id);
  }

  const towers = db.prepare('SELECT * FROM tower ORDER BY id').all();
  const insertAsset = db.prepare(
    'INSERT OR IGNORE INTO asset (asset_id, asset_type, line_id, tower_id, name, latitude, longitude, condition_rating, condition_assessed_at, lifecycle_status, operational_status, criticality, gps_validated, metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  for (const tw of towers) {
    insertAsset.run(
      `TWR-${tw.tower_id}`, 'TOWER', tw.line_id, tw.id, tw.tower_id, tw.latitude, tw.longitude,
      tw.corrosion_rating, new Date().toISOString(), 'IN_SERVICE', 'OPERATIONAL', 'MEDIUM', tw.gps_validated,
      JSON.stringify({ source: 'tower', tower_type: tw.tower_type, height_m: tw.height_m })
    );
    const have = db.prepare('SELECT COUNT(*) c FROM tower_component WHERE tower_id = ?').get(tw.id).c;
    if (have === 0) seedStandardComponents(tw.id, tw.tower_type);
  }

  // Count/route consistency: tower_count always mirrors the tower table, and
  // any line with towers derives its route from tower locations, so the
  // dashboard tower number equals the line's tower_count and route points.
  const lines = db.prepare('SELECT * FROM transmission_line').all();
  for (const l of lines) {
    syncLineTowerCount(l.id);
    if (l.veg_clearance_m === null || l.veg_clearance_m === undefined) {
      const v = Number(l.voltage_kv) || 0;
      db.prepare('UPDATE transmission_line SET veg_clearance_m = ? WHERE id = ?').run(
        v <= 50 ? 6.1 : v < 250 ? 7.6 : v < 500 ? 10.7 : 11.9, l.id
      );
    }
    const tws = db.prepare('SELECT * FROM tower WHERE line_id = ? ORDER BY km_marker, id').all(l.id);
    if (tws.length >= 2) {
      const route = tws.map((t) => [t.latitude, t.longitude]);
      let len = 0;
      for (let i = 1; i < route.length; i++) {
        len += haversine(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]) / 1000;
      }
      db.prepare('UPDATE transmission_line SET route_json = ?, length_km = ?, gps_validated = 1 WHERE id = ?').run(
        JSON.stringify(route), Math.round(len * 10) / 10, l.id
      );
    }
  }

  for (const s of db.prepare('SELECT id FROM substation').all()) syncSubstationBayCount(s.id);
}

function seedUsers() {
  const count = db.prepare('SELECT COUNT(*) c FROM user').get().c;
  if (count > 0) return;

  const mkUser = (username, password, role, regionId, personKey, extra) => {
    const person = db.prepare('SELECT id FROM person WHERE email LIKE ?').get(`%${personKey}%@%`);
    insert('user', ['username', 'password_hash', 'person_id', 'role', 'region_id', 'active', 'created_at'], {
      username,
      password_hash: hashPassword(password),
      person_id: person ? person.id : null,
      role,
      region_id: regionId || null,
      active: 1,
      created_at: new Date().toISOString(),
    });
  };

  const regionByCode = (code) => db.prepare('SELECT id FROM region WHERE code = ?').get(code)?.id || null;
  const NE = regionByCode('NE');
  const SW = regionByCode('SW');
  const CE = regionByCode('CE');

  mkUser('admin', 'Admin@123', 'ADMIN', null, 'rm-ne');
  mkUser('manager', 'Manager@123', 'REGION_MANAGER', NE, 'rm-ne');
  mkUser('supervisor', 'Sup@123', 'SUPERVISOR', NE, 'sup-ne');
  mkUser('planner', 'Planner@123', 'PLANNER', CE, 'planner-ce');
  mkUser('dispatcher', 'Dispatch@123', 'DISPATCHER', SW, 'disp-ne');
  mkUser('crew', 'Crew@123', 'FIELD_CREW', NE, 'leader-ne');
  mkUser('auditor', 'Auditor@123', 'AUDITOR', null, 'so-sw');
  mkUser('viewer', 'Viewer@123', 'VIEWER', null, 'rm-sw');

  const defaults = [
    ['language', 'en'],
    ['unit_system', 'metric'],
    ['grid_frequency_hz', '50'],
    ['currency', 'USD'],
    ['date_locale', 'en-US'],
    ['timezone', 'UTC'],
  ];
  for (const [k, v] of defaults) {
    db.prepare('INSERT OR IGNORE INTO system_config (key, value) VALUES (?,?)').run(k, v);
  }

  console.log(`Seeded users: admin, manager, supervisor, planner, dispatcher, crew, auditor, viewer`);
}
