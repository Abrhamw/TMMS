const { db } = require('./db');
const { hashPassword } = require('./auth');

// ---------------------------------------------------------------------------
// Idempotent field-role migration + crew-user provisioning.
//
// Splits the legacy FIELD_CREW role into CREW_LEAD / CREW_MEMBER based on the
// person's crew_member.role, and guarantees a login exists for every crew
// leader (CREW_LEAD) and every active non-leader member (CREW_MEMBER).
// Safe to run on every boot — never touches ADMIN/management users.
// ---------------------------------------------------------------------------

function slug(code) {
  return String(code || '').replace(/^CREW[-_]/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function personIsCrewLeader(personId) {
  if (!personId) return false;
  const asLeader = db.prepare('SELECT id FROM crew WHERE leader_person_id = ?').get(personId);
  if (asLeader) return true;
  return !!db.prepare("SELECT id FROM crew_member WHERE person_id = ? AND role = 'CREW_LEADER'").get(personId);
}

function personActiveMember(personId) {
  if (!personId) return false;
  return !!db.prepare('SELECT id FROM crew_member WHERE person_id = ? AND active = 1').get(personId);
}

function ensureUser({ username, password, role, regionId, personId }) {
  const existing = db.prepare('SELECT id, role, region_id FROM user WHERE person_id = ?').get(personId);
  if (existing) {
    // This provisioner only manages field-crew accounts. A management or
    // global account (e.g. admin) may also sit on a crew roster; re-scoping it
    // to that crew's region would silently narrow a global account on boot.
    const isCrewAccount = existing.role === 'FIELD_CREW' || existing.role === 'CREW_MEMBER' || existing.role === 'CREW_LEAD';
    if (isCrewAccount) {
      const patch = [`role = '${role}'`];
      if (existing.region_id == null && regionId != null) patch.push(`region_id = ${Number(regionId)}`);
      db.prepare(`UPDATE user SET ${patch.join(', ')} WHERE id = ?`).run(existing.id);
    }
    return existing.id;
  }
  const byUser = db.prepare('SELECT id FROM user WHERE username = ?').get(username);
  if (byUser) return byUser.id; // collision — keep the existing account
  const res = db.prepare(
    'INSERT INTO user (username, password_hash, person_id, role, region_id, active, created_at) VALUES (?,?,?,?,?,1,?)'
  ).run(username, hashPassword(password), personId, role, regionId || null, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

function migrateRolesAndCrewUsers() {
  // 1. Re-derive any legacy FIELD_CREW users from their membership.
  const legacy = db.prepare("SELECT id, person_id FROM user WHERE role = 'FIELD_CREW'").all();
  let reassigned = 0;
  for (const u of legacy) {
    if (!u.person_id) continue;
    let role = null;
    if (personIsCrewLeader(u.person_id)) role = 'CREW_LEAD';
    else if (personActiveMember(u.person_id)) role = 'CREW_MEMBER';
    if (role) {
      db.prepare('UPDATE user SET role = ? WHERE id = ?').run(role, u.id);
      reassigned++;
    }
  }

  // 2. Ensure a login exists for every crew leader and active member.
  const crews = db.prepare('SELECT id, crew_code, region_id, leader_person_id FROM crew').all();
  let created = 0;
  for (const c of crews) {
    const base = `crew.${slug(c.crew_code) || 'c' + c.id}`;
    if (c.leader_person_id) {
      const before = db.prepare('SELECT COUNT(*) n FROM user WHERE person_id = ?').get(c.leader_person_id).n;
      const id = ensureUser({
        username: `${base}.lead`,
        password: 'Crew@123',
        role: 'CREW_LEAD',
        regionId: c.region_id,
        personId: c.leader_person_id,
      });
      if (!before && id) created++;
    }
    const members = db.prepare(
      "SELECT cm.id AS mid, cm.person_id FROM crew_member cm WHERE cm.crew_id = ? AND cm.active = 1 AND cm.person_id != ?"
    ).all(c.id, c.leader_person_id || -1);
    for (const m of members) {
      if (personIsCrewLeader(m.person_id)) continue; // leaders keep CREW_LEAD across all crews
      const before = db.prepare('SELECT COUNT(*) n FROM user WHERE person_id = ?').get(m.person_id).n;
      const id = ensureUser({
        username: `${base}.m${m.mid}`,
        password: 'Member@123',
        role: 'CREW_MEMBER',
        regionId: c.region_id,
        personId: m.person_id,
      });
      if (!before && id) created++;
    }
  }

  const counts = db.prepare("SELECT role, COUNT(*) n FROM user GROUP BY role ORDER BY role").all();
  console.log(`[rolesMigrate] reassigned ${reassigned} legacy field user(s), created ${created} crew account(s). Roles: ${counts.map((r) => `${r.role}=${r.n}`).join(', ')}`);
}

module.exports = { migrateRolesAndCrewUsers };
