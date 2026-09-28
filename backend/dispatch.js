// Advisory dispatch matching.
//
// A checklist template records its crew composition as free text in
// `required_personnel` (e.g. "Team: 2 Linemen. Skill: Lineman."). Dispatch
// translates that composition into concrete crew signals — functional crew
// type, crew-member role, minimum skill level and certifications — and audits a
// candidate crew against them.
//
// This is decision support only. Dispatch warns, it never blocks: a supervisor
// may override a warning and assign any crew they have authority over. The
// equipment a checklist calls for (template materials + per-step test
// equipment) is surfaced as an advisory "equipment to secure" list; there is no
// crew equipment inventory to validate against.

const CREW_SKILL_RANK = { JUNIOR: 1, INTERMEDIATE: 2, SENIOR: 3, MASTER: 4, EXPERT: 5 };

// Maps the workbook's skill vocabulary (case-insensitive) to the crew signals
// that satisfy it. A crew covers a skill when ANY signal matches: its crew_type
// is listed, it has a member holding one of the roles at (or above) the minimum
// skill level, or it holds one of the listed valid certifications.
const SKILL_PROFILES = {
  'lineman': { crew_types: ['LINE'], roles: ['LINEMAN'], min_skill: 'INTERMEDIATE' },
  'line inspector': { crew_types: ['LINE', 'INSPECTION'], roles: ['INSPECTOR', 'LINEMAN'], min_skill: 'INTERMEDIATE' },
  'vegetation crew': { crew_types: ['LINE'], roles: ['LINEMAN'], min_skill: 'JUNIOR' },
  'thermographer': { roles: ['TECHNICIAN', 'INSPECTOR'], min_skill: 'INTERMEDIATE' },
  'transmission engineer': { crew_types: ['LINE'], roles: ['TECHNICIAN', 'INSPECTOR'], min_skill: 'SENIOR' },
  'electrical technician': { crew_types: ['SUBSTATION', 'MAINTENANCE'], roles: ['TECHNICIAN'], min_skill: 'INTERMEDIATE' },
  'technician level i': { roles: ['TECHNICIAN', 'INSPECTOR'], min_skill: 'JUNIOR' },
  'technician level ii': { roles: ['TECHNICIAN', 'INSPECTOR'], min_skill: 'INTERMEDIATE' },
  'civil technician': { roles: ['TECHNICIAN'], min_skill: 'INTERMEDIATE' },
  'civil engineer': { roles: ['TECHNICIAN', 'INSPECTOR'], min_skill: 'SENIOR' },
  'civil / testing engineer': { roles: ['TECHNICIAN', 'INSPECTOR'], min_skill: 'SENIOR', certs: ['HV_TESTING'] },
  'testing specialist': { crew_types: ['RELAY_AND_PROTECTION'], roles: ['TECHNICIAN'], min_skill: 'SENIOR', certs: ['HV_TESTING'] },
  'testing / protection': { crew_types: ['RELAY_AND_PROTECTION'], roles: ['TECHNICIAN'], min_skill: 'SENIOR', certs: ['HV_TESTING'] },
  'protection engineer': { crew_types: ['RELAY_AND_PROTECTION'], roles: ['TECHNICIAN'], min_skill: 'SENIOR', certs: ['HV_TESTING'] },
  'automation engineer': { crew_types: ['SCADA_RTU', 'TELECOM'], roles: ['TECHNICIAN'], min_skill: 'SENIOR' },
  'automation specialist': { crew_types: ['SCADA_RTU'], roles: ['TECHNICIAN'], min_skill: 'SENIOR' },
  'telecom specialist': { crew_types: ['TELECOM', 'OPGW'], roles: ['TECHNICIAN'], min_skill: 'SENIOR' },
  'telecom technician': { crew_types: ['TELECOM', 'OPGW'], roles: ['TECHNICIAN'], min_skill: 'INTERMEDIATE' },
};

// The certification vocabulary the UI issues (Certifications page). Requirements
// are only ever named from this list so a recommendation always corresponds to a
// certification a crew can actually hold.
const CERT_CATALOG = [
  'LIVE_LINE', 'HEIGHT_WORK', 'FIRST_AID', 'SWITCHING_AUTHORITY', 'SF6_HANDLING',
  'HVDC_QUALIFIED', 'CONFINED_SPACE', 'HV_TESTING', 'TOWER_CLIMBING', 'DIGGER_OPERATOR',
];

// Evidence-driven certification requirements. Each rule fires on the checklist's
// own text (name, safety notes, materials, personnel, instructions, pass
// criteria and test equipment), so SF6 work asks for SF6_HANDLING only when the
// checklist actually touches SF6, and HV testing only when a test instrument or
// diagnostic procedure appears.
const CERT_RULES = [
  { cert: 'SF6_HANDLING', level: 'REQUIRED', reason: 'SF6 gas handling / density work', re: /sf6|sulfur hexafluoride|gas density|density gauge|gas analys|dew point|purity|so2/i },
  { cert: 'LIVE_LINE', level: 'REQUIRED', reason: 'Live-line / energized work', re: /live[\s-]?line|energized line|\bhot line\b|on load/i },
  { cert: 'HV_TESTING', level: 'REQUIRED', reason: 'High-voltage diagnostic testing', re: /megger|megohmmeter|insulation resistance|polarization index|tan delta|capacitance|winding resistance|turns ratio|\bttr\b|bdv|dielectric|micro-?ohmmeter|contact resistance|timing and motion|dissolved gas|\bdga\b|karl fischer|leakage current|burden test|magnetization|high[\s-]?voltage test|hv test|withstand/i },
  { cert: 'CONFINED_SPACE', level: 'REQUIRED', reason: 'Confined-space entry', re: /confined space/i },
  { cert: 'SWITCHING_AUTHORITY', level: 'REQUIRED', reason: 'Switching / isolation / LOTO', re: /\bloto\b|lock[\s-]?out|tag[\s-]?out|isolat|de-?energiz|switching|earth switch|earthing switch/i },
  { cert: 'DIGGER_OPERATOR', level: 'REQUIRED', reason: 'Excavation / earthmoving', re: /excavat|digging|digger|auger|earthmoving|post hole/i },
  { cert: 'HVDC_QUALIFIED', level: 'REQUIRED', reason: 'HVDC systems', re: /hvdc/i },
  { cert: 'HEIGHT_WORK', level: 'REQUIRED', reason: 'Work at height', re: /work at height|fall arrest|full body harness|ladder|elevated platform/i },
  { cert: 'TOWER_CLIMBING', level: 'REQUIRED', reason: 'Tower climbing', re: /climb|steel lattice|tower structure/i },
  { cert: 'FIRST_AID', level: 'RECOMMENDED', reason: 'General field safety', re: /.*/ },
];

const LINE_ASSET_TYPES = new Set(['TOWER', 'FOUNDATION', 'GROUNDING', 'CONDUCTOR_SPAN', 'INSULATOR_STRING', 'OPGW_SPAN', 'JOINT_BOX']);

// Derives the certifications a checklist demands, with the reason each one is
// asked for. REQUIRED certs gate eligibility; RECOMMENDED certs are advisory
// (FIRST_AID is suggested for every field task).
function deriveCertRequirements(template, items = [], context = {}) {
  const found = new Map();
  const add = (cert, reason, level = 'REQUIRED') => {
    if (!CERT_CATALOG.includes(cert)) return;
    const prev = found.get(cert);
    if (!prev || (prev.level === 'RECOMMENDED' && level === 'REQUIRED')) found.set(cert, { cert, reason, level });
  };
  const hay = [
    template.name, template.code, template.asset_type, template.task_type, template.category,
    template.safety_notes, template.materials, template.required_personnel,
    ...items.flatMap((it) => [it.instruction, it.pass_criteria, it.test_equipment, it.section]),
  ].filter(Boolean).join(' \n ');
  for (const rule of CERT_RULES) if (rule.re.test(hay)) add(rule.cert, rule.reason, rule.level);
  const at = template.asset_type;
  if (LINE_ASSET_TYPES.has(at)) add('HEIGHT_WORK', 'Line / tower structure work');
  if (at === 'TOWER') add('TOWER_CLIMBING', 'Tower climbing');
  if (at === 'CIRCUIT_BREAKER') add('SF6_HANDLING', 'SF6 circuit breaker');
  if (template.task_type === 'TESTING' || template.category === 'DIAGNOSTIC') add('HV_TESTING', 'Diagnostic testing');
  if (template.requires_supervisor_verification) add('SWITCHING_AUTHORITY', 'Isolation / LOTO permit work');
  if (context.permit_required) add('SWITCHING_AUTHORITY', 'Task requires a work permit');
  if (context.is_energized_work) add('LIVE_LINE', 'Task is energized work');
  add('FIRST_AID', 'General field safety', 'RECOMMENDED');
  return [...found.values()];
}

function normKey(value) {
  return String(value || '').trim().toLowerCase();
}

function skillRank(level) {
  return CREW_SKILL_RANK[String(level || '').toUpperCase()] || 0;
}

function maxSkill(levels) {
  let best = null;
  for (const l of levels) {
    if (!l) continue;
    if (!best || skillRank(l) > skillRank(best)) best = l;
  }
  return best;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function unique(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = normKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// "Team: 2 Linemen, 1 Engineer + 2 Techs. Skill: Lineman, Testing Specialist."
function parsePersonnel(text) {
  const t = String(text || '');
  const teamMatch = /Team\s*:\s*([\s\S]*?)(?:\.\s*Skill\s*:|$)/i.exec(t);
  const skillMatch = /Skill\s*:\s*([\s\S]*?)(?:\.\s*Team\s*:|$)/i.exec(t);
  const clean = (s) => String(s || '').replace(/\.\s*$/, '');
  return {
    team: splitList(clean(teamMatch ? teamMatch[1] : '')),
    skills: splitList(clean(skillMatch ? skillMatch[1] : '')),
  };
}

// "2 Linemen" -> 2; "1 Engineer + 2 Techs" -> 3. The largest team description
// is the crew size the checklist calls for.
function teamSize(team) {
  let max = 0;
  for (const t of team) {
    const nums = String(t).match(/\d+/g);
    if (!nums) continue;
    const sum = nums.reduce((s, n) => s + Number(n), 0);
    if (sum > max) max = sum;
  }
  return max;
}

function buildRequirements(template, items = [], context = {}) {
  const { team, skills } = parsePersonnel(template.required_personnel);
  const skillReqs = skills.map((label) => {
    const profile = SKILL_PROFILES[normKey(label)];
    return {
      label,
      known: !!profile,
      crew_types: profile ? profile.crew_types || [] : [],
      roles: profile ? profile.roles || [] : [],
      min_skill: profile ? profile.min_skill || null : null,
      certs: profile ? profile.certs || [] : [],
    };
  });
  const materials = splitList(template.materials);
  const testEquipment = [];
  for (const it of items) testEquipment.push(...splitList(it.test_equipment));
  const certRequirements = deriveCertRequirements(template, items, context);
  return {
    template_id: template.id,
    template_code: template.code,
    template_name: template.name,
    task_type: template.task_type,
    team,
    min_team_size: teamSize(team),
    skills: skillReqs,
    crew_types: unique(skillReqs.flatMap((s) => s.crew_types)),
    roles: unique(skillReqs.flatMap((s) => s.roles)),
    min_skill: maxSkill(skillReqs.map((s) => s.min_skill)),
    materials,
    test_equipment: unique(testEquipment),
    equipment: unique([...materials, ...testEquipment]),
    cert_requirements: certRequirements,
    required_certs: certRequirements.filter((c) => c.level === 'REQUIRED').map((c) => c.cert),
    recommended_certs: certRequirements.filter((c) => c.level === 'RECOMMENDED').map((c) => c.cert),
  };
}

// Combine the requirements of several templates a task is governed by into one
// dispatch profile: skills/materials/certs are unioned, the team size is the
// largest single template's, and a certification required by any template stays
// REQUIRED in the merged set.
function mergeRequirements(reqs) {
  const list = (reqs || []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const skillByLabel = new Map();
  for (const r of list) for (const s of r.skills) if (!skillByLabel.has(s.label)) skillByLabel.set(s.label, s);
  const skills = [...skillByLabel.values()];
  const certByCert = new Map();
  for (const r of list) for (const c of (r.cert_requirements || [])) {
    const prev = certByCert.get(c.cert);
    if (!prev || (prev.level !== 'REQUIRED' && c.level === 'REQUIRED')) certByCert.set(c.cert, c);
  }
  const certRequirements = [...certByCert.values()];
  const largest = list.reduce((best, r) => (r.min_team_size > best.min_team_size ? r : best), list[0]);
  const materials = unique(list.flatMap((r) => r.materials || []));
  const testEquipment = unique(list.flatMap((r) => r.test_equipment || []));
  return {
    template_id: list[0].template_id,
    template_code: list.map((r) => r.template_code).filter(Boolean).join('+'),
    template_name: list.map((r) => r.template_name).filter(Boolean).join(' + '),
    template_ids: list.map((r) => r.template_id),
    task_type: largest.task_type,
    team: largest.team,
    min_team_size: largest.min_team_size,
    skills,
    crew_types: unique(list.flatMap((r) => r.crew_types || [])),
    roles: unique(list.flatMap((r) => r.roles || [])),
    min_skill: maxSkill(list.map((r) => r.min_skill)),
    materials,
    test_equipment: testEquipment,
    equipment: unique([...materials, ...testEquipment]),
    cert_requirements: certRequirements,
    required_certs: certRequirements.filter((c) => c.level === 'REQUIRED').map((c) => c.cert),
    recommended_certs: certRequirements.filter((c) => c.level === 'RECOMMENDED').map((c) => c.cert),
  };
}

function certIsValid(cert, now = Date.now()) {
  if (!cert || cert.status !== 'VALID') return false;
  if (cert.expires_at) {
    const t = Date.parse(cert.expires_at);
    if (!Number.isNaN(t) && t < now) return false;
  }
  return true;
}

function validCertTypes(crew) {
  return new Set((crew.certifications || []).filter((c) => certIsValid(c)).map((c) => c.cert_type));
}

function crewCoversSkill(crew, skill) {
  if (skill.crew_types.length && skill.crew_types.includes(crew.crew_type)) return true;
  const members = crew.members || [];
  const need = skillRank(skill.min_skill);
  for (const role of skill.roles) {
    if (members.some((m) => m.role === role && skillRank(m.skill_level) >= need)) return true;
  }
  const validCerts = validCertTypes(crew);
  for (const cert of skill.certs) if (validCerts.has(cert)) return true;
  return false;
}

function evaluateCrew(crew, req) {
  const covered = [];
  const missing = [];
  const unmapped = [];
  for (const skill of req.skills) {
    if (!skill.known) { unmapped.push(skill.label); continue; }
    (crewCoversSkill(crew, skill) ? covered : missing).push(skill.label);
  }
  const validCerts = validCertTypes(crew);
  const missingCerts = (req.required_certs || []).filter((c) => !validCerts.has(c));
  const missingRecommended = (req.recommended_certs || []).filter((c) => !validCerts.has(c));

  // What the crew would need to obtain: every unmet certification the checklist
  // asks for, with the reason it is asked and whether it gates eligibility.
  const held = [...validCerts];
  const certsToObtain = (req.cert_requirements || [])
    .filter((c) => !validCerts.has(c.cert))
    .map((c) => ({ cert: c.cert, reason: c.reason, level: c.level, required: c.level === 'REQUIRED' }));

  const members = crew.member_count != null ? crew.member_count : (crew.members || []).length;
  const shortfall = req.min_team_size ? Math.max(0, req.min_team_size - members) : 0;

  const warnings = [];
  if (missing.length) warnings.push({ type: 'SKILL', message: `No crew member/type matches: ${missing.join(', ')}` });
  if (unmapped.length) warnings.push({ type: 'SKILL_UNMAPPED', message: `No capability mapping defined for: ${unmapped.join(', ')}` });
  if (missingCerts.length) {
    const withReason = missingCerts.map((c) => {
      const meta = (req.cert_requirements || []).find((x) => x.cert === c);
      return meta ? `${c} (${meta.reason})` : c;
    });
    warnings.push({ type: 'CERT', message: `Missing required certification: ${withReason.join('; ')}` });
  }
  if (shortfall > 0) warnings.push({ type: 'TEAM_SIZE', message: `Crew has ${members} member(s); checklist team calls for ${req.min_team_size}` });
  if (req.equipment.length) warnings.push({ type: 'EQUIPMENT', message: `Confirm equipment on hand: ${req.equipment.join(', ')}` });

  const recommendations = certsToObtain.map((c) => ({
    cert: c.cert,
    reason: c.reason,
    required: c.required,
    message: `${c.required ? 'Obtain' : 'Recommended'}: ${c.cert} — ${c.reason}`,
  }));

  const eligible = !missing.length && !unmapped.length && !missingCerts.length && !shortfall;
  return {
    eligible,
    covered_skills: covered,
    missing_skills: missing,
    unmapped_skills: unmapped,
    held_certs: held,
    missing_certs: missingCerts,
    recommended_certs: missingRecommended,
    certs_to_obtain: certsToObtain,
    recommendations,
    min_team_size: req.min_team_size,
    team_shortfall: shortfall,
    equipment_to_secure: req.equipment,
    warnings,
  };
}

module.exports = {
  CREW_SKILL_RANK,
  SKILL_PROFILES,
  CERT_CATALOG,
  CERT_RULES,
  deriveCertRequirements,
  certIsValid,
  parsePersonnel,
  teamSize,
  buildRequirements,
  mergeRequirements,
  crewCoversSkill,
  evaluateCrew,
};
