const { db } = require('./db');
const { hashPassword, verifyPassword } = require('./auth');
const { polygonFromCenter } = require('./geo');
const { reconcileOrgAuthority, reconcileCrewOrgUnits } = require('./authority');

function insert(table, cols, row) {
  const placeholders = cols.map(() => '?').join(',');
  const res = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`).run(...cols.map((c) => row[c]));
  return Number(res.lastInsertRowid);
}

function isoNow() {
  return new Date().toISOString();
}

// One-time repair markers. The demo personas advertise fixed passwords, and
// older installs could hold a stale hash that no longer verified against them.
// Repairing that on every boot also overwrote passwords users had deliberately
// changed, so each repair runs exactly once and is then remembered here.
function migrationDone(key) {
  const row = db.prepare('SELECT value FROM system_config WHERE key = ?').get(key);
  return !!row && row.value === 'done';
}

function markMigrationDone(key) {
  db.prepare('INSERT INTO system_config (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, 'done');
}

function ensurePerson({ first_name, last_name, role, title, email, org_unit_id = null }) {
  const existing = db.prepare('SELECT id FROM person WHERE email = ?').get(email);
  if (existing) {
    if (org_unit_id) db.prepare('UPDATE person SET org_unit_id = ? WHERE id = ?').run(org_unit_id, existing.id);
    return existing.id;
  }
  return insert('person', ['first_name', 'last_name', 'role', 'title', 'phone', 'email', 'active', 'org_unit_id'], {
    first_name,
    last_name,
    role,
    title,
    phone: `+251-9${String(10000000 + Math.floor(Math.random() * 89999999))}`,
    email,
    active: 1,
    org_unit_id: org_unit_id || null,
  });
}

function ensureUser({ username, password, role, regionId, personId }) {
  const existing = db.prepare('SELECT id FROM user WHERE username = ?').get(username);
  if (existing) return existing.id;
  return insert('user', ['username', 'password_hash', 'person_id', 'role', 'region_id', 'active', 'created_at'], {
    username,
    password_hash: hashPassword(password),
    person_id: personId,
    role,
    region_id: regionId || null,
    active: 1,
    created_at: isoNow(),
  });
}

function ensureOrgUnit({ code, name, unitType, parentId, regionId, managerPersonId }) {
  const existing = db.prepare('SELECT id FROM org_unit WHERE unit_code = ?').get(code);
  if (existing) {
    if (regionId !== undefined) db.prepare('UPDATE org_unit SET region_id = ? WHERE id = ? AND region_id IS NULL').run(regionId, existing.id);
    if (managerPersonId !== undefined) db.prepare('UPDATE org_unit SET manager_person_id = ? WHERE id = ? AND manager_person_id IS NULL').run(managerPersonId, existing.id);
    return existing.id;
  }
  return insert('org_unit', ['unit_code', 'name', 'unit_type', 'parent_id', 'region_id', 'manager_person_id', 'sort_order'], {
    unit_code: code,
    name,
    unit_type: unitType,
    parent_id: parentId || null,
    region_id: regionId || null,
    manager_person_id: managerPersonId || null,
    sort_order: 0,
  });
}

function ensureRegion({ code, name, lat, lng, managerPersonId, contactEmail }) {
  const existing = db.prepare('SELECT id FROM region WHERE code = ?').get(code);
  if (existing) {
    if (managerPersonId) db.prepare('UPDATE region SET region_manager_person_id = ? WHERE id = ? AND region_manager_person_id IS NULL').run(managerPersonId, existing.id);
    return existing.id;
  }
  const row = {
    code,
    name,
    type: 'REGION_DIRECTORATE',
    center_lat: lat,
    center_lng: lng,
    boundary: 1.8,
    status: 'ACTIVE',
    region_manager_person_id: managerPersonId || null,
    contact_phone: '+251-11-552-3000',
    contact_email: contactEmail,
    timezone: 'Africa/Addis_Ababa',
    notes: 'Regional Transmission Substation Operation directorate',
    boundary_json: JSON.stringify(polygonFromCenter(lat, lng, 1.8 * 111320, 14)),
  };
  return insert('region', Object.keys(row), row);
}

function ensureCrew({ name, code, crewType, regionId, leaderPersonId, homeBase }) {
  const existing = db.prepare('SELECT id FROM crew WHERE crew_code = ?').get(code);
  const cid = existing ? existing.id : insert('crew', ['name', 'crew_code', 'crew_type', 'region_id', 'leader_person_id', 'home_base', 'status'], {
    name,
    crew_code: code,
    crew_type: crewType,
    region_id: regionId,
    leader_person_id: leaderPersonId || null,
    home_base: homeBase || 'Regional Depot',
    status: 'AVAILABLE',
  });
  if (leaderPersonId && !db.prepare('SELECT id FROM crew_member WHERE crew_id = ? AND person_id = ?').get(cid, leaderPersonId)) {
    insert('crew_member', ['crew_id', 'person_id', 'role', 'skill_level', 'active'], {
      crew_id: cid,
      person_id: leaderPersonId,
      role: 'CREW_LEADER',
      skill_level: 'SENIOR',
      active: 1,
    });
  }
  return cid;
}

// ---------------------------------------------------------------------------
// EEP Transmission & Substation Operation org skeleton.
// 13 regional directorates named "<Area> Region Transmission Substation
// Operation", corporate executive team, and the fully-staffed Central 1
// directorate (departments + crews). Physical network (substations/lines/
// assets) is intentionally left empty for the user to populate.
// Idempotent: safe to run on every boot.
// ---------------------------------------------------------------------------
const REGION_DEFS = [
  { code: 'C1', area: 'Central 1', lat: 9.02, lng: 38.74 },
  { code: 'C2', area: 'Central 2', lat: 8.63, lng: 39.27 },
  { code: 'C3', area: 'Central 3', lat: 8.1, lng: 37.4 },
  { code: 'E1', area: 'East 1', lat: 9.6, lng: 41.85 },
  { code: 'E2', area: 'East 2', lat: 7.5, lng: 40.0 },
  { code: 'S1', area: 'South 1', lat: 6.0, lng: 37.55 },
  { code: 'S2', area: 'South 2', lat: 5.6, lng: 39.2 },
  { code: 'SW', area: 'South West', lat: 7.2, lng: 35.7 },
  { code: 'NO', area: 'North', lat: 11.6, lng: 37.36 },
  { code: 'NE1', area: 'North East 1', lat: 13.48, lng: 39.47 },
  { code: 'NE2', area: 'North East 2', lat: 11.3, lng: 41.0 },
  { code: 'NW', area: 'North West', lat: 12.6, lng: 37.2 },
  { code: 'WE', area: 'West', lat: 9.3, lng: 35.5 },
];

// Executive / leadership personas from the original EEP database.
const EXEC_PERSONAS = [
  { key: 'admin', username: 'admin', password: 'Admin@123', userRole: 'ADMIN', first_name: 'Abrham', last_name: 'Workie', personRole: 'MANAGER', title: 'System Creator', email: 'admin@eep-tmms.com.et' },
  { key: 'ceo', username: 'ceo', password: 'Executive@123', userRole: 'EXECUTIVE', first_name: 'Ashebir', last_name: 'Balcha', personRole: 'EXECUTIVE', title: 'Chief Executive Officer', email: 'ceo@eep-tmms.com.et' },
  { key: 'tbu', username: 'exec.tbu', password: 'Executive@123', userRole: 'EXECUTIVE', first_name: 'Destalem', last_name: 'Hailu', personRole: 'ENGINEER', title: 'DCEO, Transmission Business Unit', email: 'tbu@eep-tmms.com.et' },
  { key: 'tso', username: 'exec.tso', password: 'Executive@123', userRole: 'EXECUTIVE', first_name: 'Girma', last_name: 'Zeleke', personRole: 'ENGINEER', title: 'Executive, Transmission Substation Operations', email: 'tso@eep-tmms.com.et' },
  { key: 'rc', username: 'dir.rc', password: 'Executive@123', userRole: 'EXECUTIVE', first_name: 'Wondwossen', last_name: 'Abebe', personRole: 'ENGINEER', title: 'Director, Region Coordinations', email: 'rc@eep-tmms.com.et' },
];

const C1_MANAGERS = [
  { username: 'dir.c1', password: 'Region@123', userRole: 'REGION_DIRECTOR', first_name: 'Dereje', last_name: 'Gezahagn', personRole: 'REGION_DIRECTOR', title: 'Director, Central 1 Region Transmission Substation Operation', email: 'c1tso@eep-tmms.com.et' },
  { username: 'mgr.c1.som', password: 'Manager@123', userRole: 'REGION_MANAGER', first_name: 'Getnet', last_name: 'Tesfaye', personRole: 'MANAGER', title: 'Manager, Substation Operation & Maintenance', email: 'c1ssom@eep-tmms.com.et' },
  { username: 'mgr.c1.tlom', password: 'Manager@123', userRole: 'REGION_MANAGER', first_name: 'Fikadu', last_name: 'Bekele', personRole: 'MANAGER', title: 'Manager, Transmission Line & OPGW Maintenance', email: 'tlom@eep-tmms.com.et' },
  { username: 'mgr.c1.rs', password: 'Manager@123', userRole: 'REGION_MANAGER', first_name: 'Molla', last_name: 'Kebede', personRole: 'MANAGER', title: 'Manager, RTU Telecom SCADA & Protection', email: 'c1rtsp@eep-tmms.com.et' },
];

const OT_PERSONA = {
  username: 'dir.ot', password: 'Executive@123', userRole: 'OT_MANAGER',
  first_name: 'Tewodros', last_name: 'Alemu', personRole: 'MANAGER',
  title: 'Director, Operational Technology', email: 'ot@eep-tmms.com.et',
};

// Heads of the OT child departments. They hold the same OT_MANAGER role as the
// department head but are scoped to their own unit subtree and domain.
const OT_CHILD_MANAGERS = [
  {
    username: 'mgr.ot.prot', password: 'Manager@123', userRole: 'OT_MANAGER',
    first_name: 'Selam', last_name: 'Girma', personRole: 'MANAGER',
    title: 'Manager, Protection & Control', email: 'ot.prot@eep-tmms.com.et',
    unitCode: 'DEPT-OT-PC', unitName: 'Protection & Control', unitType: 'OT_PROTECTION_CONTROL',
  },
  {
    username: 'mgr.ot.scada', password: 'Manager@123', userRole: 'OT_MANAGER',
    first_name: 'Biniam', last_name: 'Assefa', personRole: 'MANAGER',
    title: 'Manager, SCADA & Automation', email: 'ot.scada@eep-tmms.com.et',
    unitCode: 'DEPT-OT-SA', unitName: 'SCADA & Automation', unitType: 'OT_SCADA_AUTOMATION',
  },
  {
    username: 'mgr.ot.tel', password: 'Manager@123', userRole: 'OT_MANAGER',
    first_name: 'Hirut', last_name: 'Desta', personRole: 'MANAGER',
    title: 'Manager, Telecom & Fiber', email: 'ot.tel@eep-tmms.com.et',
    unitCode: 'DEPT-OT-TF', unitName: 'Telecom & Fiber', unitType: 'OT_TELECOM_FIBER',
  },
];

function ensureCenterCrew({ name, code, crewType, regionId, orgUnitId, lead, member }) {
  const leadId = ensurePerson({ first_name: lead.first_name, last_name: lead.last_name, role: lead.role, title: lead.title, email: lead.email, org_unit_id: orgUnitId });
  const memberId = ensurePerson({ first_name: member.first_name, last_name: member.last_name, role: member.role, title: member.title, email: member.email, org_unit_id: orgUnitId });
  ensureUser({ username: lead.username, password: lead.password, role: 'CREW_LEAD', regionId, personId: leadId });
  const existing = db.prepare('SELECT id FROM crew WHERE crew_code = ?').get(code);
  let cid;
  if (existing) {
    cid = existing.id;
    db.prepare('UPDATE crew SET org_unit_id = COALESCE(org_unit_id, ?) WHERE id = ?').run(orgUnitId, cid);
  } else {
    cid = insert('crew', ['name', 'crew_code', 'crew_type', 'region_id', 'leader_person_id', 'home_base', 'status', 'org_unit_id'], {
      name, crew_code: code, crew_type: crewType, region_id: regionId, leader_person_id: leadId,
      home_base: 'Central Depot', status: 'AVAILABLE', org_unit_id: orgUnitId,
    });
  }
  if (!db.prepare('SELECT id FROM crew_member WHERE crew_id = ? AND person_id = ?').get(cid, leadId)) {
    insert('crew_member', ['crew_id', 'person_id', 'role', 'skill_level', 'active'], { crew_id: cid, person_id: leadId, role: 'CREW_LEADER', skill_level: 'SENIOR', active: 1 });
  }
  if (!db.prepare('SELECT id FROM crew_member WHERE crew_id = ? AND person_id = ?').get(cid, memberId)) {
    insert('crew_member', ['crew_id', 'person_id', 'role', 'skill_level', 'active'], { crew_id: cid, person_id: memberId, role: 'LINEMAN', skill_level: 'SENIOR', active: 1 });
  }
  return cid;
}

function seedEep() {
  // ---- People + login accounts -------------------------------------------
  const execIds = {};
  for (const p of EXEC_PERSONAS) {
    const pid = ensurePerson({ first_name: p.first_name, last_name: p.last_name, role: p.personRole, title: p.title, email: p.email });
    ensureUser({ username: p.username, password: p.password, role: p.userRole, regionId: null, personId: pid });
    execIds[p.key] = pid;
  }

  const c1Ids = {};
  for (const p of C1_MANAGERS) {
    const pid = ensurePerson({ first_name: p.first_name, last_name: p.last_name, role: p.personRole, title: p.title, email: p.email });
    c1Ids[p.username] = pid;
  }

  // ---- Org tree -----------------------------------------------------------
  const hq = ensureOrgUnit({ code: 'HQ-CEO', name: 'Chief Executive Officer', unitType: 'CORPORATE', parentId: null, managerPersonId: execIds.ceo });
  const tbu = ensureOrgUnit({ code: 'BU-TBU', name: 'Transmission Business Unit', unitType: 'BUSINESS_UNIT', parentId: hq, managerPersonId: execIds.tbu });
  const execTso = ensureOrgUnit({ code: 'DIV-TSO-EXEC', name: 'Transmission Substation Operation Executive', unitType: 'DIVISION', parentId: tbu, managerPersonId: execIds.tso });
  const regCoord = ensureOrgUnit({ code: 'DIV-REGCOORD', name: 'Director, Region Coordinations', unitType: 'DIVISION', parentId: execTso, managerPersonId: execIds.rc });

  // ---- 13 regions + directorate org units --------------------------------
  const regionIds = {};
  const regionByCode = {};
  for (const r of REGION_DEFS) {
    const c1Dir = r.code === 'C1' ? c1Ids['dir.c1'] : null;
    const email = r.code === 'C1' ? 'c1tso@eep-tmms.com.et' : `tso.${r.code.toLowerCase()}@eep-tmms.com.et`;
    const rid = ensureRegion({ code: r.code, name: `${r.area} Region Transmission Substation Operation`, lat: r.lat, lng: r.lng, managerPersonId: c1Dir, contactEmail: email });
    regionIds[r.code] = rid;
    regionByCode[r.code] = rid;
    const dirCode = `DIR-${r.code}`;
    ensureOrgUnit({ code: dirCode, name: `${r.area} Region Transmission Substation Operation`, unitType: 'REGION_DIRECTORATE', parentId: regCoord, regionId: rid, managerPersonId: c1Dir });
  }

  // ---- Central 1 directorate departments + crews ---------------------------
  const dirC1 = db.prepare('SELECT id FROM org_unit WHERE unit_code = ?').get('DIR-C1').id;
  const deptSom = ensureOrgUnit({ code: 'DEPT-C1-SOM', name: 'Central 1 Substation Operation & Maintenance', unitType: 'SUBSTATION_MAINTENANCE', parentId: dirC1, regionId: regionByCode.C1, managerPersonId: c1Ids['mgr.c1.som'] });
  const deptTlom = ensureOrgUnit({ code: 'DEPT-C1-TLOM', name: 'Central 1 Transmission Line & OPGW Maintenance', unitType: 'TRANSMISSION_MAINTENANCE', parentId: dirC1, regionId: regionByCode.C1, managerPersonId: c1Ids['mgr.c1.tlom'] });
  const deptRs = ensureOrgUnit({ code: 'DEPT-C1-RS', name: 'Central 1 RTU Telecom SCADA & Protection', unitType: 'RELAY_SCADA_TELECOM', parentId: dirC1, regionId: regionByCode.C1, managerPersonId: c1Ids['mgr.c1.rs'] });
  db.prepare('UPDATE person SET org_unit_id = ? WHERE id = ?').run(deptSom, c1Ids['mgr.c1.som']);
  db.prepare('UPDATE person SET org_unit_id = ? WHERE id = ?').run(deptTlom, c1Ids['mgr.c1.tlom']);
  db.prepare('UPDATE person SET org_unit_id = ? WHERE id = ?').run(deptRs, c1Ids['mgr.c1.rs']);

  // Central 1 crew leads + members (preserved from the original database).
  const leadSom = ensurePerson({ first_name: 'C1SSOM', last_name: 'Crew 1', role: 'CREW_LEAD', title: 'Central 1 SSO&M Crew Lead', email: 'c1ssomc@eep-tmms.com.et', org_unit_id: deptSom });
  const leadTlom = ensurePerson({ first_name: 'C1TLOM', last_name: 'Crew 2', role: 'CREW_LEAD', title: 'Central 1 TL&OM Crew Lead', email: 'c1tlomc@eep-tmms.com.et', org_unit_id: deptTlom });
  const crewSom = ensureCrew({ name: 'Central 1 Substation O&M Crew', code: 'CREW-C1-SOM', crewType: 'SUBSTATION', regionId: regionByCode.C1, leaderPersonId: leadSom, homeBase: 'Legetafo Depot' });
  const crewTlom = ensureCrew({ name: 'Central 1 Transmission Line & OPGW Crew', code: 'CREW-C1-TLOM', crewType: 'LINE', regionId: regionByCode.C1, leaderPersonId: leadTlom, homeBase: 'Legetafo Depot' });
  const leadRtsp = ensurePerson({ first_name: 'Batu', last_name: 'Crew 3', role: 'CREW_LEAD', title: 'Central 1 Relay control scada expert', email: 'c1rtspc@eep-tmms.com.et', org_unit_id: deptRs });
  ensureCrew({ name: 'Central 1 RTU Telecom, SCADA & Protection', code: 'CREW-C1-RTSP', crewType: 'RELAY_AND_PROTECTION', regionId: regionByCode.C1, leaderPersonId: leadRtsp, homeBase: 'Arat Killo' });
  const mem1 = ensurePerson({ first_name: 'C1SSOM', last_name: 'Member 1', role: 'MEMBER', title: 'Substation Transformer Expert', email: 'c1ssomm1@eep-tmms.com.et', org_unit_id: deptSom });
  const mem2 = ensurePerson({ first_name: 'C1TLOM', last_name: 'Member 1', role: 'MEMBER', title: 'Transmission Lineman', email: 'c1tlomm1@eep-tmms.com.et', org_unit_id: deptTlom });
  db.prepare('INSERT INTO crew_member (crew_id, person_id, role, skill_level, active) VALUES (?,?,?,?,?)').run(crewSom, mem1, 'LINEMAN', 'SENIOR', 1);
  db.prepare('INSERT INTO crew_member (crew_id, person_id, role, skill_level, active) VALUES (?,?,?,?,?)').run(crewTlom, mem2, 'LINEMAN', 'SENIOR', 1);

  // Central 1 field-crew login accounts.
  ensureUser({ username: 'crew.c1', password: 'Crew@123', role: 'FIELD_CREW', regionId: regionByCode.C1, personId: leadSom });
  // C1 manager login accounts (region-scoped to Central 1).
  ensureUser({ username: 'dir.c1', password: 'Region@123', role: 'REGION_DIRECTOR', regionId: regionByCode.C1, personId: c1Ids['dir.c1'] });
  ensureUser({ username: 'mgr.c1.som', password: 'Manager@123', role: 'REGION_MANAGER', regionId: regionByCode.C1, personId: c1Ids['mgr.c1.som'] });
  ensureUser({ username: 'mgr.c1.tlom', password: 'Manager@123', role: 'REGION_MANAGER', regionId: regionByCode.C1, personId: c1Ids['mgr.c1.tlom'] });
  ensureUser({ username: 'mgr.c1.rs', password: 'Manager@123', role: 'REGION_MANAGER', regionId: regionByCode.C1, personId: c1Ids['mgr.c1.rs'] });

  // ---- Region personnel linkage for Central 1 ------------------------------
  if (!db.prepare('SELECT id FROM region_personnel WHERE region_id = ? AND person_id = ?').get(regionByCode.C1, c1Ids['dir.c1'])) {
    insert('region_personnel', ['region_id', 'person_id', 'role', 'is_primary'], { region_id: regionByCode.C1, person_id: c1Ids['dir.c1'], role: 'REGION_DIRECTOR', is_primary: 1 });
  }

  // ---- System defaults -----------------------------------------------------
  const defaults = [
    ['language', 'en'],
    ['unit_system', 'metric'],
    ['grid_frequency_hz', '50'],
    ['currency', 'ETB'],
    ['date_locale', 'en-ET'],
    ['timezone', 'Africa/Addis_Ababa'],
  ];
  for (const [k, v] of defaults) {
    db.prepare('INSERT OR IGNORE INTO system_config (key, value) VALUES (?,?)').run(k, v);
  }

  console.log(
    `Seeded EEP org: ${REGION_DEFS.length} regions, ${EXEC_PERSONAS.length} executives, Central 1 directorate (${C1_MANAGERS.length} managers + 3 crews).`
  );
}

// ---------------------------------------------------------------------------
// Idempotent boot reconciliation. seedEep() only runs on a fresh (empty)
// database, so existing installs can drift from the persona intent defined
// above (e.g. manager accounts created by older seeds with the wrong role).
// Run on every boot so live users always match the seeded role model.
// ---------------------------------------------------------------------------
function reconcileSeedUsers() {
  const c1 = db.prepare('SELECT id FROM region WHERE code = ?').get('C1');
  const c1RegionId = c1 ? c1.id : null;
  const intent = [
    ...EXEC_PERSONAS.map((p) => ({ username: p.username, password: p.password, role: p.userRole, regionId: null })),
    ...C1_MANAGERS.map((p) => ({ username: p.username, password: p.password, role: p.userRole, regionId: c1RegionId })),
    { username: OT_PERSONA.username, password: OT_PERSONA.password, role: OT_PERSONA.userRole, regionId: c1RegionId },
    ...OT_CHILD_MANAGERS.map((p) => ({ username: p.username, password: p.password, role: p.userRole, regionId: c1RegionId })),
  ];
  let fixed = 0;
  let pwFixed = 0;
  const pwRepairDone = migrationDone('seed_persona_pw_repair_v1');
  for (const u of intent) {
    const existing = db.prepare('SELECT id, role, region_id, password_hash FROM user WHERE username = ?').get(u.username);
    if (!existing) continue;
    const wantRegion = u.regionId == null ? null : Number(u.regionId);
    const patch = [];
    if (existing.role !== u.role) patch.push(`role = '${u.role}'`);
    // The persona intent is authoritative for its region, including "all
    // regions" (null). Force the value so a global persona that a crew-roster
    // backfill once pinned to a region is restored to global on boot.
    if (existing.region_id !== wantRegion) {
      patch.push(wantRegion == null ? 'region_id = NULL' : `region_id = ${wantRegion}`);
    }
    if (patch.length) {
      db.prepare(`UPDATE user SET ${patch.join(', ')} WHERE id = ?`).run(existing.id);
      fixed++;
    }
    // Accounts created by older seeds can hold a stale hash that no longer
    // verifies against the persona password advertised by the demo UI. Repair
    // once, then leave user-chosen passwords alone across restarts.
    if (!pwRepairDone && !verifyPassword(u.password, existing.password_hash)) {
      db.prepare('UPDATE user SET password_hash = ? WHERE id = ?').run(hashPassword(u.password), existing.id);
      pwFixed++;
    }
  }
  if (!pwRepairDone) markMigrationDone('seed_persona_pw_repair_v1');
  if (fixed > 0) console.log(`[seed_eep] reconciled ${fixed} drifted login(s) to persona intent`);
  if (pwFixed > 0) console.log(`[seed_eep] reset ${pwFixed} stale persona password(s) to persona intent`);
}

// Repair demo-data inconsistencies from earlier migrations: malformed crew
// codes and crew memberships that tie office/management accounts (admin, the
// Substation crew lead) to unrelated crews. Deactivates rather than deletes.
function repairCrewData() {
  const renamed = db.prepare("UPDATE crew SET crew_code = 'CREW-C1-RTSP' WHERE crew_code = 'C1RTSP crew1'").run().changes;
  const c1 = db.prepare('SELECT id FROM region WHERE code = ?').get('C1');
  const cleanups = [
    // Admin (person 1) must not be a lineman on the C1 TL&OM crew.
    "UPDATE crew_member SET active = 0 WHERE person_id = 1 AND role = 'LINEMAN' AND active = 1",
    // The SOM crew lead (person 10) leads crew 1 and must not also crew crew 3.
    "UPDATE crew_member SET active = 0 WHERE person_id = 10 AND crew_id != 1 AND active = 1",
  ];
  let deactivated = 0;
  for (const sql of cleanups) {
    if (c1) deactivated += db.prepare(sql).run().changes;
  }
  if (renamed || deactivated) console.log(`[seed_eep] repaired crew data: ${renamed} code(s) renamed, ${deactivated} bogus membership(s) deactivated`);
}

// Field-crew login accounts split by rolesMigrate into CREW_LEAD / CREW_MEMBER
// carry the persona password their role advertises in the demo UI. Existing
// rows (legacy crew.c1, or members pre-created by older seeds) can keep a
// stale hash, so re-sync any hash that fails verification.
function reconcileCrewAccountPasswords() {
  if (migrationDone('seed_crew_pw_repair_v1')) return;
  const accounts = db.prepare("SELECT id, username, role, password_hash FROM user WHERE role IN ('CREW_LEAD', 'CREW_MEMBER')").all();
  let fixed = 0;
  for (const a of accounts) {
    const expected = a.role === 'CREW_LEAD' ? 'Crew@123' : 'Member@123';
    if (!verifyPassword(expected, a.password_hash)) {
      db.prepare('UPDATE user SET password_hash = ? WHERE id = ?').run(hashPassword(expected), a.id);
      fixed++;
    }
  }
  markMigrationDone('seed_crew_pw_repair_v1');
  if (fixed > 0) console.log(`[seed_eep] reset ${fixed} stale crew account password(s) to role persona`);
}

function migrateLegacyManagerRoles() {
  const roles = ['SUBSTATION_MANAGER', 'TRANSMISSION_MANAGER', 'RELAY_SCADA_MANAGER'];
  const n = db.prepare(`UPDATE user SET role = 'REGION_MANAGER' WHERE role IN (${roles.map(() => '?').join(',')})`).run(...roles).changes;
  if (n) console.log(`[seed_eep] migrated ${n} legacy manager role(s) to REGION_MANAGER`);
}

function ensureOperationalTechnology() {
  const tso = db.prepare('SELECT id FROM org_unit WHERE unit_code = ?').get('DIV-TSO-EXEC');
  const regCoord = db.prepare('SELECT id FROM org_unit WHERE unit_code = ?').get('DIV-REGCOORD');
  const dirC1 = db.prepare('SELECT id FROM org_unit WHERE unit_code = ?').get('DIR-C1');
  const c1 = db.prepare('SELECT id FROM region WHERE code = ?').get('C1');
  if (!tso || !c1) return;

  const otPid = ensurePerson({ first_name: OT_PERSONA.first_name, last_name: OT_PERSONA.last_name, role: OT_PERSONA.personRole, title: OT_PERSONA.title, email: OT_PERSONA.email });
  const otUnit = ensureOrgUnit({ code: 'DIV-OT', name: 'Operational Technology', unitType: 'OPERATIONAL_TECHNOLOGY', parentId: tso.id, managerPersonId: otPid });
  db.prepare('UPDATE person SET org_unit_id = ? WHERE id = ?').run(otUnit, otPid);
  ensureUser({ username: OT_PERSONA.username, password: OT_PERSONA.password, role: OT_PERSONA.userRole, regionId: c1.id, personId: otPid });

  // ---- OT child departments: Protection & Control, SCADA & Automation,
  // Telecom & Fiber. Each is a department under the OT unit with its own head,
  // its own domain, and its own crews.
  const childUnits = {};
  for (const m of OT_CHILD_MANAGERS) {
    const pid = ensurePerson({ first_name: m.first_name, last_name: m.last_name, role: m.personRole, title: m.title, email: m.email });
    const unit = ensureOrgUnit({ code: m.unitCode, name: m.unitName, unitType: m.unitType, parentId: otUnit, regionId: c1.id, managerPersonId: pid });
    db.prepare('UPDATE person SET org_unit_id = ? WHERE id = ?').run(unit, pid);
    ensureUser({ username: m.username, password: m.password, role: m.userRole, regionId: c1.id, personId: pid });
    childUnits[m.unitCode] = unit;
  }

  if (regCoord) {
    ensureCenterCrew({
      name: 'Region Coordination Special Works Crew', code: 'CREW-RC-SPECIAL', crewType: 'MAINTENANCE',
      regionId: c1.id, orgUnitId: regCoord.id,
      lead: { username: 'crew.rcspecial.lead', password: 'Crew@123', role: 'CREW_LEAD', first_name: 'RC', last_name: 'Special Lead', title: 'Region Coordination Special Works Lead', email: 'rcspecial.lead@eep-tmms.com.et' },
      member: { role: 'MEMBER', first_name: 'RC', last_name: 'Special Member', title: 'Special Works Technician', email: 'rcspecial.member@eep-tmms.com.et' },
    });
  }
  if (dirC1) {
    ensureCenterCrew({
      name: 'Central 1 Regional Special Works Crew', code: 'CREW-C1-SPECIAL', crewType: 'MAINTENANCE',
      regionId: c1.id, orgUnitId: dirC1.id,
      lead: { username: 'crew.c1special.lead', password: 'Crew@123', role: 'CREW_LEAD', first_name: 'C1', last_name: 'Special Lead', title: 'Central 1 Special Works Lead', email: 'c1special.lead@eep-tmms.com.et' },
      member: { role: 'MEMBER', first_name: 'C1', last_name: 'Special Member', title: 'Special Works Technician', email: 'c1special.member@eep-tmms.com.et' },
    });
  }
  const pcUnit = childUnits['DEPT-OT-PC'] || otUnit;
  const saUnit = childUnits['DEPT-OT-SA'] || otUnit;
  const tfUnit = childUnits['DEPT-OT-TF'] || otUnit;
  ensureCenterCrew({
    name: 'OT Relay & Protection Crew', code: 'CREW-OT-RLY', crewType: 'RELAY_AND_PROTECTION',
    regionId: c1.id, orgUnitId: pcUnit,
    lead: { username: 'crew.otrly.lead', password: 'Crew@123', role: 'CREW_LEAD', first_name: 'OT', last_name: 'Relay Lead', title: 'OT Relay & Protection Lead', email: 'otrly.lead@eep-tmms.com.et' },
    member: { role: 'MEMBER', first_name: 'OT', last_name: 'Relay Member', title: 'Protection Technician', email: 'otrly.member@eep-tmms.com.et' },
  });
  ensureCenterCrew({
    name: 'OT Protection & Control Crew', code: 'CREW-OT-PROT', crewType: 'PROTECTION_CONTROL',
    regionId: c1.id, orgUnitId: pcUnit,
    lead: { username: 'crew.otprot.lead', password: 'Crew@123', role: 'CREW_LEAD', first_name: 'OT', last_name: 'Protection Lead', title: 'OT Protection & Control Lead', email: 'otprot.lead@eep-tmms.com.et' },
    member: { role: 'MEMBER', first_name: 'OT', last_name: 'Protection Member', title: 'Metering Technician', email: 'otprot.member@eep-tmms.com.et' },
  });
  ensureCenterCrew({
    name: 'OT SCADA & RTU Crew', code: 'CREW-OT-SCADA', crewType: 'SCADA_RTU',
    regionId: c1.id, orgUnitId: saUnit,
    lead: { username: 'crew.otscada.lead', password: 'Crew@123', role: 'CREW_LEAD', first_name: 'OT', last_name: 'SCADA Lead', title: 'OT SCADA & RTU Lead', email: 'otscada.lead@eep-tmms.com.et' },
    member: { role: 'MEMBER', first_name: 'OT', last_name: 'SCADA Member', title: 'RTU Technician', email: 'otscada.member@eep-tmms.com.et' },
  });
  ensureCenterCrew({
    name: 'OT Telecom & Fiber Crew', code: 'CREW-OT-TEL', crewType: 'TELECOM_FIBER',
    regionId: c1.id, orgUnitId: tfUnit,
    lead: { username: 'crew.ottel.lead', password: 'Crew@123', role: 'CREW_LEAD', first_name: 'OT', last_name: 'Telecom Lead', title: 'OT Telecom & Fiber Lead', email: 'ottel.lead@eep-tmms.com.et' },
    member: { role: 'MEMBER', first_name: 'OT', last_name: 'Telecom Member', title: 'Fiber Technician', email: 'ottel.member@eep-tmms.com.et' },
  });
  // DC & auxiliary has no child department of its own; it stays directly under
  // the OT department.
  ensureCenterCrew({
    name: 'OT DC & Auxiliary Crew', code: 'CREW-OT-DC', crewType: 'DC_SYSTEMS',
    regionId: c1.id, orgUnitId: otUnit,
    lead: { username: 'crew.otdc.lead', password: 'Crew@123', role: 'CREW_LEAD', first_name: 'OT', last_name: 'DC Lead', title: 'OT DC & Auxiliary Lead', email: 'otdc.lead@eep-tmms.com.et' },
    member: { role: 'MEMBER', first_name: 'OT', last_name: 'DC Member', title: 'DC Systems Technician', email: 'otdc.member@eep-tmms.com.et' },
  });
}

const CREW_UNIT_MAP = [
  ['CREW-C1-SOM', 'DEPT-C1-SOM'],
  ['CREW-C1-TLOM', 'DEPT-C1-TLOM'],
  ['CREW-C1-RTSP', 'DEPT-C1-RS'],
  ['CREW-OT-RLY', 'DEPT-OT-PC'],
  ['CREW-OT-PROT', 'DEPT-OT-PC'],
  ['CREW-OT-SCADA', 'DEPT-OT-SA'],
  ['CREW-OT-TEL', 'DEPT-OT-TF'],
  ['CREW-OT-DC', 'DIV-OT'],
];

function backfillCrewOrgUnits() {
  let n = 0;
  for (const [crewCode, unitCode] of CREW_UNIT_MAP) {
    const unit = db.prepare('SELECT id FROM org_unit WHERE unit_code = ?').get(unitCode);
    if (!unit) continue;
    n += db.prepare('UPDATE crew SET org_unit_id = ? WHERE crew_code = ? AND (org_unit_id IS NULL OR org_unit_id != ?)').run(unit.id, crewCode, unit.id).changes;
  }
  const dirC1 = db.prepare('SELECT id FROM org_unit WHERE unit_code = ?').get('DIR-C1');
  const dirUser = db.prepare('SELECT person_id FROM user WHERE username = ?').get('dir.c1');
  if (dirC1 && dirUser && dirUser.person_id) {
    db.prepare('UPDATE person SET org_unit_id = ? WHERE id = ? AND org_unit_id IS NULL').run(dirC1.id, dirUser.person_id);
  }
  if (n) console.log(`[seed_eep] backfilled ${n} crew org-unit link(s)`);
}

function reconcileSeedData() {
  migrateLegacyManagerRoles();
  ensureOperationalTechnology();
  backfillCrewOrgUnits();
  reconcileCrewOrgUnits();
  reconcileSeedUsers();
  reconcileCrewAccountPasswords();
  repairCrewData();
  // Last, so it sees seed-repaired roles: keep the unit-head link and each
  // manager's home unit in agreement (the head link is authoritative).
  reconcileOrgAuthority();
}

module.exports = { seedEep, reconcileSeedData, REGION_DEFS };
