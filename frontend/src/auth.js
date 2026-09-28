import { api } from './api';
import { getSessionToken, getSessionUser, setSession, setSessionUser, clearSession, getAccounts, rememberAccount, forgetAccount } from './session';

// Mirror of the backend RBAC permission matrix.
// Master-data writes (regions, substations, lines, towers, assets, checklists,
// users) are ADMIN-only. Management roles of the Transmission hierarchy run the
// operational workflow (task create/assign/verify, schedule create/run,
// reporting); field crews are split into CREW_LEAD (run/submit/amend + add
// findings) and CREW_MEMBER (start work and field capture: readings/GPS/photos;
// the lead submits the run for verification).

const READ_PERMS = [
  'dashboard:read', 'map:read', 'region:read', 'substation:read',
  'line:read', 'tower:read', 'asset:read', 'task:read',
  'crew:read', 'people:read', 'schedule:read', 'checklist:read',
  'gps:read', 'geofence:read', 'report:read', 'settings:read', 'cert:read',
];

const TASK_WORKFLOW = ['task:create', 'task:assign', 'task:verify', 'task:manage'];

const OPERATIONS_WORKFLOW = [...TASK_WORKFLOW, 'schedule:write', 'schedule:run', 'report:write', 'asset:evaluate', 'task:bulk', 'geofence:write', 'gps:review'];

const REGION_MANAGER_PERMS = [...READ_PERMS, ...OPERATIONS_WORKFLOW, 'task:execute', 'gps:write', 'attachment:write'];

const FIELD_READS = [
  'dashboard:read', 'map:read', 'region:read', 'substation:read', 'line:read', 'tower:read',
  'asset:read', 'task:read', 'gps:read', 'geofence:read', 'cert:read',
];

const ROLE_PERMS = {
  ADMIN: ['*'],
  EXECUTIVE: [...READ_PERMS, ...OPERATIONS_WORKFLOW, 'audit:read'],
  VIEWER: READ_PERMS,
  AUDITOR: [...READ_PERMS, 'report:write', 'audit:read'],
  REGION_DIRECTOR: [...READ_PERMS, ...OPERATIONS_WORKFLOW],
  REGION_MANAGER: REGION_MANAGER_PERMS,
  OT_MANAGER: REGION_MANAGER_PERMS,
  SUBSTATION_MANAGER: REGION_MANAGER_PERMS,
  TRANSMISSION_MANAGER: REGION_MANAGER_PERMS,
  RELAY_SCADA_MANAGER: REGION_MANAGER_PERMS,
  SUPERVISOR: [...READ_PERMS, ...OPERATIONS_WORKFLOW],
  PLANNER: [...READ_PERMS, 'task:create', 'task:manage', 'schedule:write', 'schedule:run', 'task:bulk'],
  DISPATCHER: [...READ_PERMS, 'task:create', 'task:assign'],
  CREW_LEAD: [...FIELD_READS, 'task:execute', 'task:start', 'task:lead', 'task:amend', 'gps:write', 'attachment:write'],
  CREW_MEMBER: [...FIELD_READS, 'task:execute', 'task:start', 'gps:write', 'attachment:write'],
  FIELD_CREW: [...FIELD_READS, 'task:execute', 'task:start', 'task:lead', 'task:amend', 'gps:write', 'attachment:write'],
};

const GLOBAL_ROLES = ['ADMIN', 'EXECUTIVE', 'VIEWER', 'AUDITOR'];

export const CREW_ROLES = ['FIELD_CREW', 'CREW_LEAD', 'CREW_MEMBER'];

export function can(user, perm) {
  if (!user) return false;
  const perms = ROLE_PERMS[user.role];
  if (!perms) return false;
  return perms.includes('*') || perms.includes(perm);
}

export function isGlobal(user) {
  return !!user && GLOBAL_ROLES.includes(user.role);
}

export function hasRead(user, base) {
  return can(user, `${base}:read`);
}

export function getStoredUser() {
  try {
    const raw = getSessionUser();
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export function getStoredToken() {
  return getSessionToken();
}

export async function login(username, password) {
  const data = await api.post('/auth/login', { username, password });
  setSession(data.token, data.user);
  return data.user;
}

export async function logout() {
  const token = getSessionToken();
  const user = getStoredUser();
  try {
    await api.post('/auth/logout');
  } catch (_) {
    /* ignore */
  }
  clearSession(token);
  if (user) forgetAccount(user.id);
}

// ---------------------------------------------------------------------------
// Account switching (two users on one device)
// ---------------------------------------------------------------------------
export function listAccounts() {
  return getAccounts();
}

export function listOtherAccounts() {
  const current = getStoredUser();
  return getAccounts().filter((a) => a.user.id !== current?.id);
}

// Make another remembered account the active one for this tab and device. The
// token is re-validated against the server; a stale token falls back to the
// cached user so the caller can route the user to sign in again.
export async function switchAccount(token) {
  const account = getAccounts().find((a) => a.token === token);
  if (!account) return null;
  setSession(account.token, account.user);
  try {
    const data = await api.get('/auth/me');
    setSessionUser(data.user);
    rememberAccount(account.token, data.user);
    return data.user;
  } catch (_) {
    return account.user;
  }
}

export function removeAccount(userId) {
  forgetAccount(userId);
}


export function setStoredUser(user) {
  setSessionUser(user);
}

export async function refreshMe() {
  const data = await api.get('/auth/me');
  setStoredUser(data.user);
  return data.user;
}
