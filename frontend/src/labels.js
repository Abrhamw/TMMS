import { t } from './i18n';

// Human-readable labels for raw workflow codes. Keeps jargon like
// PENDING_VERIFICATION out of the interface and centralises the mapping so
// every surface shows the same wording.
const STATUS_KEYS = {
  DRAFT: 'draft',
  SCHEDULED: 'scheduled',
  ASSIGNED: 'stAssigned',
  IN_PROGRESS: 'stInProgress',
  ON_HOLD: 'stOnHold',
  PENDING_VERIFICATION: 'stPendingVerification',
  COMPLETED: 'completed',
  CANCELLED: 'stCancelled',
  FAILED: 'stFailed',
};

const PRIORITY_KEYS = {
  CRITICAL: 'prCritical',
  HIGH: 'prHigh',
  MEDIUM: 'prMedium',
  LOW: 'prLow',
};

const TYPE_KEYS = {
  PREVENTIVE: 'tyPreventive',
  CORRECTIVE: 'tyCorrective',
  EMERGENCY: 'tyEmergency',
  INSPECTION: 'tyInspection',
  REPLACEMENT: 'tyReplacement',
  TESTING: 'tyTesting',
  REPAIR: 'tyRepair',
  DIAGNOSTIC: 'tyDiagnostic',
};

const CERT_KEYS = {
  VALID: 'certValid',
  EXPIRED: 'certExpired',
  EXPIRING: 'certExpiring',
  REVOKED: 'certRevoked',
};

function fromMap(map, code, fallback) {
  if (code === null || code === undefined || code === '') return fallback ?? '—';
  const key = map[String(code)];
  return key ? t(key) : String(code);
}

export function statusLabel(code) {
  return fromMap(STATUS_KEYS, code);
}

export function priorityLabel(code) {
  return fromMap(PRIORITY_KEYS, code);
}

export function taskTypeLabel(code) {
  return fromMap(TYPE_KEYS, code);
}

export function certLabel(code) {
  return fromMap(CERT_KEYS, code);
}

// Generic human label for a workflow code; unknown codes pass through so
// technical identifiers are never hidden.
export function codeLabel(code) {
  return fromMap(STATUS_KEYS, code, fromMap(CERT_KEYS, code, undefined) ?? String(code ?? ''));
}
