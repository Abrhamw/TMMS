const MAX_QUERY = 200;
const MAX_TOKENS = 16;

const OPEN_STATUSES = ['DRAFT', 'SCHEDULED', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'PENDING_VERIFICATION'];

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by',
  'from', 'with', 'without', 'about', 'into', 'over', 'under', 'across',
  'show', 'me', 'find', 'list', 'get', 'give', 'display', 'search', 'look',
  'please', 'all', 'any', 'some', 'those', 'these', 'that', 'this',
  'what', 'where', 'which', 'who', 'whose', 'how', 'are', 'is', 'was', 'were',
  'be', 'been', 'being', 'do', 'does', 'did', 'can', 'could', 'should', 'would',
  'i', 'we', 'my', 'our', 'their', 'there', 'here', 'it', 'its',
  'related', 'records', 'record', 'equipment', 'items', 'item',
  'need', 'want', 'see', 'go', 'let', 'us', 'bring', 'up',
  'only', 'just', 'also', 'still', 'very', 'too',
]);

const TYPE_PHRASES = [
  [['transmission', 'lines'], { types: ['line'] }],
  [['transmission', 'line'], { types: ['line'] }],
  [['circuit', 'breakers'], { types: ['asset'], assetTypes: ['HV_CIRCUIT_BREAKER', 'MV_CIRCUIT_BREAKER', 'CIRCUIT_BREAKER'] }],
  [['circuit', 'breaker'], { types: ['asset'], assetTypes: ['HV_CIRCUIT_BREAKER', 'MV_CIRCUIT_BREAKER', 'CIRCUIT_BREAKER'] }],
  [['auto', 'transformers'], { types: ['asset'], assetTypes: ['AUTO_TRANSFORMER', 'TRANSFORMER'] }],
  [['auto', 'transformer'], { types: ['asset'], assetTypes: ['AUTO_TRANSFORMER', 'TRANSFORMER'] }],
  [['capacitor', 'banks'], { types: ['asset'], assetTypes: ['CAPACITOR_BANK'] }],
  [['capacitor', 'bank'], { types: ['asset'], assetTypes: ['CAPACITOR_BANK'] }],
  [['protection', 'relays'], { types: ['asset'], assetTypes: ['PROTECTION_RELAY'] }],
  [['protection', 'relay'], { types: ['asset'], assetTypes: ['PROTECTION_RELAY'] }],
  [['battery', 'banks'], { types: ['asset'], assetTypes: ['BATTERY_BANK'] }],
  [['battery', 'bank'], { types: ['asset'], assetTypes: ['BATTERY_BANK'] }],
  [['work', 'orders'], { types: ['task'] }],
  [['work', 'order'], { types: ['task'] }],
  [['substations'], { types: ['substation'] }],
  [['substation'], { types: ['substation'] }],
  [['transformers'], { types: ['asset'], assetTypes: ['TRANSFORMER', 'AUTO_TRANSFORMER', 'AUXILIARY_TRANSFORMER'] }],
  [['transformer'], { types: ['asset'], assetTypes: ['TRANSFORMER', 'AUTO_TRANSFORMER', 'AUXILIARY_TRANSFORMER'] }],
  [['breakers'], { types: ['asset'], assetTypes: ['HV_CIRCUIT_BREAKER', 'MV_CIRCUIT_BREAKER', 'CIRCUIT_BREAKER'] }],
  [['breaker'], { types: ['asset'], assetTypes: ['HV_CIRCUIT_BREAKER', 'MV_CIRCUIT_BREAKER', 'CIRCUIT_BREAKER'] }],
  [['relays'], { types: ['asset'], assetTypes: ['PROTECTION_RELAY'] }],
  [['relay'], { types: ['asset'], assetTypes: ['PROTECTION_RELAY'] }],
  [['reactors'], { types: ['asset'], assetTypes: ['REACTOR'] }],
  [['reactor'], { types: ['asset'], assetTypes: ['REACTOR'] }],
  [['inspections'], { taskTypes: ['INSPECTION'] }],
  [['inspection'], { taskTypes: ['INSPECTION'] }],
  [['schedules'], { types: ['schedule'] }],
  [['schedule'], { types: ['schedule'] }],
  [['towers'], { types: ['tower'] }],
  [['tower'], { types: ['tower'] }],
  [['assets'], { types: ['asset'] }],
  [['asset'], { types: ['asset'] }],
  [['tasks'], { types: ['task'] }],
  [['task'], { types: ['task'] }],
  [['jobs'], { types: ['task'] }],
  [['job'], { types: ['task'] }],
  [['crews'], { types: ['crew'] }],
  [['crew'], { types: ['crew'] }],
  [['people'], { types: ['person'] }],
  [['persons'], { types: ['person'] }],
  [['person'], { types: ['person'] }],
  [['personnel'], { types: ['person'] }],
  [['staff'], { types: ['person'] }],
  [['regions'], { types: ['region'] }],
  [['region'], { types: ['region'] }],
  [['lines'], { types: ['line'] }],
  [['line'], { types: ['line'] }],
  [['ss'], { types: ['substation'] }],
];

const STATUS_PHRASES = [
  [['pending', 'verification'], { statuses: ['PENDING_VERIFICATION'] }],
  [['in', 'progress'], { statuses: ['IN_PROGRESS'] }],
  [['on', 'hold'], { statuses: ['ON_HOLD'] }],
  [['past', 'due'], { overdue: true }],
  [['overdue'], { overdue: true }],
  [['late'], { overdue: true }],
  [['failed'], { statuses: ['FAILED'] }],
  [['fail'], { statuses: ['FAILED'] }],
  [['failure'], { statuses: ['FAILED'] }],
  [['completed'], { statuses: ['COMPLETED'] }],
  [['complete'], { statuses: ['COMPLETED'] }],
  [['finished'], { statuses: ['COMPLETED'] }],
  [['done'], { statuses: ['COMPLETED'] }],
  [['cancelled'], { statuses: ['CANCELLED'] }],
  [['canceled'], { statuses: ['CANCELLED'] }],
  [['draft'], { statuses: ['DRAFT'] }],
  [['scheduled'], { statuses: ['SCHEDULED'] }],
  [['assigned'], { statuses: ['ASSIGNED'] }],
  [['ongoing'], { statuses: ['IN_PROGRESS'] }],
  [['paused'], { statuses: ['ON_HOLD'] }],
  [['pending'], { statuses: ['PENDING_VERIFICATION'] }],
  [['open'], { open: true }],
  [['outstanding'], { open: true }],
  [['unfinished'], { open: true }],
  [['active'], { open: true }],
];

const PRIORITY_PHRASES = [
  [['high', 'priority'], { priorities: ['HIGH'] }],
  [['low', 'priority'], { priorities: ['LOW'] }],
  [['critical'], { priorities: ['CRITICAL'] }],
  [['emergency'], { priorities: ['CRITICAL'], taskTypes: ['EMERGENCY'] }],
  [['urgent'], { priorities: ['CRITICAL'] }],
  [['high'], { priorities: ['HIGH'] }],
  [['medium'], { priorities: ['MEDIUM'] }],
  [['normal'], { priorities: ['MEDIUM'] }],
  [['low'], { priorities: ['LOW'] }],
];

const TASK_TYPE_PHRASES = [
  [['preventive'], { taskTypes: ['PREVENTIVE'] }],
  [['corrective'], { taskTypes: ['CORRECTIVE'] }],
  [['repair'], { taskTypes: ['CORRECTIVE'] }],
  [['inspect'], { taskTypes: ['INSPECTION'] }],
];

const PERSONAL_PHRASES = [
  [['assigned', 'to', 'me'], { mine: true }],
  [['for', 'me'], { mine: true }],
  [['to', 'me'], { mine: true }],
  [['my'], { mine: true }],
  [['mine'], { mine: true }],
];

function text(v) {
  return v == null ? '' : String(v);
}

function fieldText(v) {
  return text(v).toLowerCase();
}

function normalizeQuery(q) {
  return text(q).trim().slice(0, MAX_QUERY).toLowerCase()
    .replace(/[^\p{L}\p{N}./+-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(q) {
  const raw = normalizeQuery(q);
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS);
}

function matches(tokens, fields) {
  if (!tokens || !tokens.length) return false;
  const haystacks = (fields || []).map(fieldText);
  return tokens.every((token) => haystacks.some((h) => h.includes(token)));
}

function rank(tokens, titleFields, extraFields) {
  if (!tokens || !tokens.length) return 0;
  const titles = (titleFields || []).map(fieldText);
  const extras = (extraFields || []).map(fieldText);
  let score = 0;
  for (const token of tokens) {
    if (titles.some((h) => h.includes(token))) score += 3;
    else if (extras.some((h) => h.includes(token))) score += 1;
  }
  return score;
}

function emptyIntent() {
  return {
    types: [],
    assetTypes: [],
    statuses: [],
    priorities: [],
    taskTypes: [],
    typeWords: [],
    overdue: false,
    open: false,
    mine: false,
    dateFrom: null,
    dateTo: null,
  };
}

function mergeInto(intent, patch) {
  if (!patch) return;
  for (const key of ['types', 'assetTypes', 'statuses', 'priorities', 'taskTypes']) {
    if (!patch[key]) continue;
    for (const value of patch[key]) {
      if (!intent[key].includes(value)) intent[key].push(value);
    }
  }
  if (patch.overdue) intent.overdue = true;
  if (patch.open) intent.open = true;
  if (patch.mine) intent.mine = true;
  if (patch.dateFrom && (!intent.dateFrom || patch.dateFrom < intent.dateFrom)) intent.dateFrom = patch.dateFrom;
  if (patch.dateTo && (!intent.dateTo || patch.dateTo > intent.dateTo)) intent.dateTo = patch.dateTo;
}

function matchPhrase(tokens, i, phrases) {
  for (const [words, patch] of phrases) {
    if (i + words.length > tokens.length) continue;
    let ok = true;
    for (let k = 0; k < words.length; k += 1) {
      if (tokens[i + k] !== words[k]) { ok = false; break; }
    }
    if (ok) return { length: words.length, patch };
  }
  return null;
}

function isoDay(date, end) {
  const d = new Date(date);
  if (end) d.setUTCHours(23, 59, 59, 999);
  else d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function parseDatePhrase(tokens, i, now) {
  const a = tokens[i];
  const b = tokens[i + 1];
  const c = tokens[i + 2];
  if (a === 'today') return { length: 1, patch: { dateFrom: isoDay(now, false), dateTo: isoDay(now, true) } };
  if (a === 'yesterday') {
    const y = addDays(now, -1);
    return { length: 1, patch: { dateFrom: isoDay(y, false), dateTo: isoDay(y, true) } };
  }
  if (a === 'tomorrow') {
    const t = addDays(now, 1);
    return { length: 1, patch: { dateFrom: isoDay(t, false), dateTo: isoDay(t, true) } };
  }
  if ((a === 'this' || a === 'last' || a === 'past' || a === 'next') && b) {
    const origin = new Date(now);
    origin.setUTCHours(0, 0, 0, 0);
    if (b === 'week' || b === 'weeks') {
      if (a === 'this') {
        const day = origin.getUTCDay() || 7;
        const start = addDays(origin, 1 - day);
        return { length: 2, patch: { dateFrom: isoDay(start, false), dateTo: isoDay(now, true) } };
      }
      if (a === 'next') {
        const day = origin.getUTCDay() || 7;
        const start = addDays(origin, 8 - day);
        return { length: 2, patch: { dateFrom: isoDay(start, false), dateTo: isoDay(addDays(start, 6), true) } };
      }
      return { length: 2, patch: { dateFrom: isoDay(addDays(now, -7), false), dateTo: isoDay(now, true) } };
    }
    if (b === 'month' || b === 'months') {
      if (a === 'this') {
        const start = new Date(Date.UTC(origin.getUTCFullYear(), origin.getUTCMonth(), 1));
        return { length: 2, patch: { dateFrom: isoDay(start, false), dateTo: isoDay(now, true) } };
      }
      if (a === 'next') {
        const start = new Date(Date.UTC(origin.getUTCFullYear(), origin.getUTCMonth() + 1, 1));
        const end = new Date(Date.UTC(origin.getUTCFullYear(), origin.getUTCMonth() + 2, 0));
        return { length: 2, patch: { dateFrom: isoDay(start, false), dateTo: isoDay(end, true) } };
      }
      return { length: 2, patch: { dateFrom: isoDay(addDays(now, -30), false), dateTo: isoDay(now, true) } };
    }
    if (b === 'year' || b === 'years') {
      if (a === 'this') {
        const start = new Date(Date.UTC(origin.getUTCFullYear(), 0, 1));
        return { length: 2, patch: { dateFrom: isoDay(start, false), dateTo: isoDay(now, true) } };
      }
      return { length: 2, patch: { dateFrom: isoDay(addDays(now, -365), false), dateTo: isoDay(now, true) } };
    }
  }
  if ((a === 'last' || a === 'past') && /^\d+$/.test(b || '') && (c === 'days' || c === 'day' || c === 'weeks' || c === 'week' || c === 'months' || c === 'month')) {
    const n = Number(b);
    const unit = c.startsWith('week') ? 7 : c.startsWith('month') ? 30 : 1;
    return { length: 3, patch: { dateFrom: isoDay(addDays(now, -n * unit), false), dateTo: isoDay(now, true) } };
  }
  return null;
}

function hasSearchIntent(intent) {
  if (!intent) return false;
  return !!(
    (intent.types && intent.types.length)
    || (intent.assetTypes && intent.assetTypes.length)
    || (intent.statuses && intent.statuses.length)
    || (intent.priorities && intent.priorities.length)
    || (intent.taskTypes && intent.taskTypes.length)
    || intent.overdue
    || intent.open
    || intent.mine
    || intent.dateFrom
    || intent.dateTo
  );
}

function parseSearchQuery(raw, now = new Date()) {
  const trimmed = text(raw).trim().slice(0, MAX_QUERY);
  const tokensIn = tokenize(trimmed);
  const intent = emptyIntent();
  const leftover = [];
  const typeWords = [];
  for (let i = 0; i < tokensIn.length;) {
    const dateHit = parseDatePhrase(tokensIn, i, now);
    if (dateHit) { mergeInto(intent, dateHit.patch); i += dateHit.length; continue; }
    const personalHit = matchPhrase(tokensIn, i, PERSONAL_PHRASES);
    if (personalHit) { mergeInto(intent, personalHit.patch); i += personalHit.length; continue; }
    const statusHit = matchPhrase(tokensIn, i, STATUS_PHRASES);
    if (statusHit) { mergeInto(intent, statusHit.patch); i += statusHit.length; continue; }
    const typeHit = matchPhrase(tokensIn, i, TYPE_PHRASES);
    if (typeHit) {
      mergeInto(intent, typeHit.patch);
      leftover.push(...tokensIn.slice(i, i + typeHit.length));
      typeWords.push(...tokensIn.slice(i, i + typeHit.length));
      i += typeHit.length;
      continue;
    }
    const priorityHit = matchPhrase(tokensIn, i, PRIORITY_PHRASES);
    if (priorityHit) { mergeInto(intent, priorityHit.patch); i += priorityHit.length; continue; }
    const taskHit = matchPhrase(tokensIn, i, TASK_TYPE_PHRASES);
    if (taskHit) { mergeInto(intent, taskHit.patch); leftover.push(...tokensIn.slice(i, i + taskHit.length)); i += taskHit.length; continue; }
    const token = tokensIn[i];
    i += 1;
    if (STOP_WORDS.has(token)) continue;
    leftover.push(token);
  }
  intent.typeWords = typeWords;
  if (!intent.types.length && (intent.overdue || intent.open || intent.statuses.length || intent.priorities.length || intent.taskTypes.length || intent.dateFrom || intent.mine)) {
    intent.types.push('task');
    if (intent.overdue || intent.dateFrom) intent.types.push('schedule');
  }
  if (!intent.types.length && intent.assetTypes.length) intent.types.push('asset');
  return { raw: trimmed, tokens: leftover, intent };
}

function rowDate(type, row) {
  if (type === 'task') return row.due_date || row.scheduled_start || row.created_at || null;
  if (type === 'schedule') return row.next_due_date || null;
  return null;
}

function rowMatchesIntent(type, row, intent) {
  if (!intent || !hasSearchIntent(intent)) return true;
  if (intent.assetTypes.length && type === 'asset' && !intent.assetTypes.includes(row.asset_type)) return false;
  if (intent.taskTypes.length && type === 'task' && !intent.taskTypes.includes(row.task_type)) return false;
  if (intent.priorities.length && type === 'task' && !intent.priorities.includes(row.priority)) return false;
  if (intent.statuses.length && type === 'task' && !intent.statuses.includes(row.status)) return false;
  if (intent.open && type === 'task' && !OPEN_STATUSES.includes(row.status)) return false;
  if (intent.overdue) {
    const now = new Date().toISOString();
    if (type === 'task') {
      if (!(OPEN_STATUSES.includes(row.status) && row.due_date && row.due_date < now)) return false;
    } else if (type === 'schedule') {
      if (!(Number(row.is_active) === 1 && row.next_due_date && row.next_due_date < now)) return false;
    }
  }
  if ((intent.dateFrom || intent.dateTo) && (type === 'task' || type === 'schedule')) {
    const value = rowDate(type, row);
    if (!value) return false;
    if (intent.dateFrom && value < intent.dateFrom) return false;
    if (intent.dateTo && value > intent.dateTo) return false;
  }
  return true;
}

function shouldSearchType(type, intent, tokens) {
  if (intent && intent.mine && intent.types && intent.types.length) return intent.types.includes(type);
  if (tokens && tokens.length) return true;
  if (!intent || !intent.types.length) return true;
  return intent.types.includes(type);
}

function intentAppliesToType(type, intent) {
  if (!intent) return false;
  if (intent.mine && intent.types && intent.types.includes(type)) return true;
  if (type === 'task' && (intent.overdue || intent.open || intent.mine || intent.statuses.length || intent.priorities.length || intent.taskTypes.length || intent.dateFrom)) return true;
  if (type === 'schedule' && (intent.overdue || intent.dateFrom || intent.mine)) return true;
  if (type === 'asset' && intent.assetTypes.length) return true;
  return false;
}

function rowMatchesMine(type, row, actor) {
  if (!actor) return false;
  const personId = actor.personId != null ? Number(actor.personId) : null;
  const crewIds = actor.crewIds instanceof Set ? actor.crewIds : new Set(actor.crewIds || []);
  if (type === 'task') {
    if (row.crew_id != null && crewIds.has(Number(row.crew_id))) return true;
    if (personId != null && [row.created_by, row.assigned_by, row.verified_by].includes(personId)) return true;
    return false;
  }
  if (type === 'crew') return crewIds.has(Number(row.id));
  if (type === 'person') return personId != null && Number(row.id) === personId;
  if (type === 'schedule') return row.responsible_crew_id != null && crewIds.has(Number(row.responsible_crew_id));
  return true;
}

function tokensForType(type, tokens, intent) {
  const words = intent && intent.typeWords ? intent.typeWords : [];
  if (!words.length || !tokens || !tokens.length) return tokens;
  if (!(intent.types || []).includes(type)) return tokens;
  const skip = new Set(words);
  return tokens.filter((token) => !skip.has(token));
}

function searchGroup({ type, label, rows, tokens, limit, titleFields, extraFields, toItem, intent }) {
  const scored = [];
  const used = tokensForType(type, tokens, intent);
  const typed = !!(intent && intent.types && intent.types.includes(type));
  const allowEmpty = (!used || !used.length) && (intentAppliesToType(type, intent) || typed);
  for (const row of rows) {
    if (!rowMatchesIntent(type, row, intent)) continue;
    const titles = titleFields(row);
    const extras = extraFields ? extraFields(row) : [];
    if (!allowEmpty && !matches(used, titles.concat(extras))) continue;
    scored.push({
      score: used && used.length ? rank(used, titles, extras) : 1,
      id: row.id,
      item: toItem(row),
    });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.id - a.id));
  return {
    type,
    label,
    total: scored.length,
    items: scored.slice(0, limit).map((x) => ({ ...x.item, rank: x.score })),
  };
}

function assetTypeSlug(assetType) {
  return String(assetType || '').trim().toLowerCase();
}

function groupMatchesIntent(group, intent) {
  if (!intent || !hasSearchIntent(intent)) return true;
  const entity = group.entity || group.type;
  if (intent.types.length && !intent.types.includes(entity)) return false;
  if (intent.assetTypes.length && entity === 'asset') {
    const slugs = intent.assetTypes.map(assetTypeSlug);
    const type = String(group.type || '').toLowerCase();
    return slugs.some((s) => type === s || s.endsWith(type) || type.endsWith(s));
  }
  return true;
}

function filterGroupsByIntent(groups, intent) {
  if (!intent || !intent.types || !intent.types.length) return groups;
  return groups.filter((group) => groupMatchesIntent(group, intent) && group.total > 0);
}

module.exports = {
  MAX_QUERY,
  MAX_TOKENS,
  OPEN_STATUSES,
  tokenize,
  matches,
  rank,
  parseSearchQuery,
  searchGroup,
  hasSearchIntent,
  rowMatchesIntent,
  filterGroupsByIntent,
  groupMatchesIntent,
  shouldSearchType,
  intentAppliesToType,
  rowMatchesMine,
};
