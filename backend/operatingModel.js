// The operating model ties the organisational structure to the application
// roles. Each role has one primary function and owns a small, non-overlapping
// set of task buckets, so a Home view never mixes "to schedule", "to assign",
// "to verify", "to execute" and "to raise an emergency" in one list.
//
// This module is pure (no database access) so the account model, the API and
// the UI all agree. The pictorial companion is docs/SYSTEM_MAP.md.
const { hasPerm, isGlobal, isCrewRole } = require('./auth');

// Organisational bands, top to bottom, and the unit types that sit in each.
const ORG_BANDS = [
  { key: 'corporate', label: 'Corporate HQ / Business Unit', unit_types: ['CORPORATE', 'BUSINESS_UNIT', 'DIVISION'] },
  { key: 'directorate', label: 'Regional Directorate', unit_types: ['REGION_DIRECTORATE'] },
  { key: 'department', label: 'Regional Department', unit_types: ['DEPARTMENT', 'SUBSTATION_MAINTENANCE', 'TRANSMISSION_MAINTENANCE', 'RELAY_SCADA_TELECOM', 'OPERATIONAL_TECHNOLOGY', 'OT_PROTECTION_CONTROL', 'OT_SCADA_AUTOMATION', 'OT_TELECOM_FIBER'] },
  { key: 'substation', label: 'Substation Unit', unit_types: ['SUBSTATION_UNIT'] },
  { key: 'crew', label: 'Field Crew', unit_types: [] },
];

// The role that heads (or works in) each org unit type. Legacy department-head
// role names map to REGION_MANAGER behaviour.
const UNIT_ROLE = {
  CORPORATE: 'EXECUTIVE',
  BUSINESS_UNIT: 'EXECUTIVE',
  DIVISION: 'EXECUTIVE',
  REGION_DIRECTORATE: 'REGION_DIRECTOR',
  DEPARTMENT: 'REGION_MANAGER',
  SUBSTATION_MAINTENANCE: 'REGION_MANAGER',
  TRANSMISSION_MAINTENANCE: 'REGION_MANAGER',
  RELAY_SCADA_TELECOM: 'OT_MANAGER',
  OPERATIONAL_TECHNOLOGY: 'OT_MANAGER',
  OT_PROTECTION_CONTROL: 'OT_MANAGER',
  OT_SCADA_AUTOMATION: 'OT_MANAGER',
  OT_TELECOM_FIBER: 'OT_MANAGER',
  SUBSTATION_UNIT: 'REGION_MANAGER',
};

// One primary function per role, and the single bucket that function leads with.
const ROLE_FUNCTION = {
  ADMIN: { label: 'System administration', band: 'Corporate HQ', bucket: null },
  EXECUTIVE: { label: 'Company-wide oversight', band: 'Corporate HQ / Business Unit', bucket: 'oversight' },
  REGION_DIRECTOR: { label: 'Owns the region', band: 'Regional Directorate', bucket: 'assign' },
  SUPERVISOR: { label: 'Operational supervision', band: 'Regional Department', bucket: 'verify' },
  REGION_MANAGER: { label: 'Commands a department', band: 'Regional Department', bucket: 'assign' },
  OT_MANAGER: { label: 'Commands an OT department', band: 'Operational Technology', bucket: 'assign' },
  SUBSTATION_MANAGER: { label: 'Commands a substation unit', band: 'Substation Unit', bucket: 'assign' },
  TRANSMISSION_MANAGER: { label: 'Commands transmission maintenance', band: 'Regional Department', bucket: 'assign' },
  RELAY_SCADA_MANAGER: { label: 'Commands RTU / SCADA / telecom', band: 'Regional Department', bucket: 'assign' },
  PLANNER: { label: 'Plans the programme', band: 'Planning cell', bucket: 'schedule' },
  DISPATCHER: { label: 'Dispatches work', band: 'Dispatch desk', bucket: 'assign' },
  CREW_LEAD: { label: 'Executes and submits', band: 'Field Crew', bucket: 'execute' },
  FIELD_CREW: { label: 'Executes and submits', band: 'Field Crew', bucket: 'execute' },
  CREW_MEMBER: { label: 'Captures field evidence', band: 'Field Crew', bucket: 'execute' },
  AUDITOR: { label: 'Independent review', band: 'Audit', bucket: 'audit' },
  VIEWER: { label: 'Read-only', band: '—', bucket: 'oversight' },
};

const BUCKETS = {
  execute: { key: 'execute', label: 'My work — execute', action: 'start / capture / submit', hint: 'Tasks assigned to your crew. Start the work, capture the checklist, and the crew lead submits it.' },
  schedule: { key: 'schedule', label: 'To schedule', action: 'schedule', hint: 'Draft work waiting to go on the calendar.' },
  assign: { key: 'assign', label: 'To assign', action: 'assign', hint: 'Planned or emergency work with no crew yet.' },
  assigned: { key: 'assigned', label: 'Assigned to your crews', action: 'open', hint: 'Work already handed to crews you command — an oversight lens on active assignments.' },
  verify: { key: 'verify', label: 'To verify', action: 'verify', hint: 'Submitted field work waiting for sign-off.' },
  emergency: { key: 'emergency', label: 'Emergency', action: 'raise emergency', hint: 'Urgent failures raised as EMERGENCY tasks and dispatched at once.' },
  audit: { key: 'audit', label: 'Review evidence', action: 'review', hint: 'Pending verifications and evidence to review. Read-only.' },
  oversight: { key: 'oversight', label: 'Oversight', action: 'review', hint: 'Exceptions only: critical overdue work, GPS violations, expiring certifications.' },
};

function roleFunction(user) {
  const role = user && user.role;
  const f = ROLE_FUNCTION[role] || { label: role || '—', band: '—', bucket: null };
  return { role: role || null, ...f };
}

// Capability-driven ownership. A manager holds assign + verify + create, so
// they see separate "To schedule", "To assign", "To verify" and "Emergency"
// sections rather than one undifferentiated queue.
function ownedBuckets(user) {
  if (!user) return [];
  const out = [];
  if (isCrewRole(user.role) && hasPerm(user, 'task:execute')) out.push('execute');
  // "To schedule" belongs to the planning function (task:manage), not to every
  // actor who may perform the DRAFT→SCHEDULED move, so a dispatcher's Home is
  // not confused with a planner's.
  if (hasPerm(user, 'task:manage')) out.push('schedule');
  if (hasPerm(user, 'task:assign')) out.push('assign');
  if (hasPerm(user, 'task:assign')) out.push('assigned');
  if (hasPerm(user, 'task:verify')) out.push('verify');
  if (hasPerm(user, 'task:create')) out.push('emergency');
  if (hasPerm(user, 'audit:read')) out.push('audit');
  if (isGlobal(user)) out.push('oversight');
  return [...new Set(out)];
}

module.exports = { ORG_BANDS, UNIT_ROLE, ROLE_FUNCTION, BUCKETS, roleFunction, ownedBuckets };
