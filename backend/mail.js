const { db, get, insertRow } = require('./util');

// Resolve the account that receives mail addressed to a person. A person may
// hold several accounts; the primary (lowest id) is the delivery target while
// the message is still filed per-person so every account sees it in the inbox.
function primaryUserForPerson(personId) {
  if (!personId) return null;
  return db.prepare('SELECT id, username FROM user WHERE person_id = ? AND active = 1 ORDER BY id LIMIT 1').get(Number(personId)) || null;
}

// The immediate line manager of the crew that owns the work: the crew lead,
// else the region manager, else an org-unit manager anchored in the region.
function immediateBossForTask(task) {
  if (!task) return null;
  if (task.crew_id) {
    const c = get('crew', task.crew_id);
    if (c && c.leader_person_id) return c.leader_person_id;
  }
  if (task.region_id) {
    const r = get('region', task.region_id);
    if (r && r.region_manager_person_id) return r.region_manager_person_id;
    const u = db.prepare(
      'SELECT manager_person_id FROM org_unit WHERE region_id = ? AND manager_person_id IS NOT NULL ORDER BY sort_order, id LIMIT 1'
    ).get(task.region_id);
    if (u && u.manager_person_id) return u.manager_person_id;
  }
  return null;
}

// Insert a directed mailbox message. Returns the new id, or null when there is
// no resolvable recipient.
function sendMail({
  senderUserId = null,
  senderPersonId = null,
  recipientPersonId,
  subject = '',
  body = '',
  category = 'GENERAL',
  priority = 'NORMAL',
  status = 'SENT',
  entityType = null,
  entityId = null,
  link = null,
  threadId = null,
  attachments = [],
}) {
  const rid = Number(recipientPersonId);
  if (!rid) return null;
  const now = new Date().toISOString();
  const recipientUser = primaryUserForPerson(rid);
  const sent = status === 'SENT';
  const id = insertRow('message', {
    sender_user_id: senderUserId,
    sender_person_id: senderPersonId,
    recipient_person_id: rid,
    recipient_user_id: recipientUser ? recipientUser.id : null,
    subject: String(subject || '').trim().slice(0, 200),
    body: String(body || '').trim().slice(0, 20000),
    category,
    priority,
    status,
    entity_type: entityType,
    entity_id: entityId,
    link,
    thread_id: threadId,
    created_at: now,
    updated_at: now,
    sent_at: sent ? now : null,
  });
  for (const a of (Array.isArray(attachments) ? attachments : []).slice(0, 20)) {
    if (!a || a.entity_id == null) continue;
    insertRow('message_attachment', {
      message_id: id,
      kind: a.kind || 'DOC',
      entity_type: a.entity_type || null,
      entity_id: Number(a.entity_id),
      label: a.label ? String(a.label).slice(0, 200) : null,
      link: a.link ? String(a.link).slice(0, 400) : null,
      file_name: null,
      stored_name: null,
      mime: null,
      size_bytes: null,
      created_at: now,
    });
  }
  return id;
}

// Junk classification. The signal list is deliberately small and explainable:
// external sender domain, a spam keyword hit, or an unknown/inactive sender.
const SPAM_KEYWORDS = [
  'lottery', 'wire transfer', 'click here', 'winner', 'crypto', 'bitcoin',
  'urgent transfer', 'act now', 'nigerian', 'claim your', 'you have won',
  'bank details', 'verify your account', 'limited time offer', 'free money',
];

function domainOf(email) {
  const s = String(email || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  return at > 0 ? s.slice(at + 1) : '';
}

// Internal domains are the distinct domains of active people who hold an active
// account in this system, built once per process. A mailbox with no such people
// simply never fires the external-domain signal rather than flagging everything.
let internalDomainCache = null;
function internalDomains() {
  if (internalDomainCache) return internalDomainCache;
  const set = new Set();
  try {
    const rows = db.prepare(
      `SELECT DISTINCT p.email FROM person p
         JOIN user u ON u.person_id = p.id AND u.active = 1
        WHERE p.active = 1 AND p.email IS NOT NULL AND p.email LIKE '%@%'`
    ).all();
    for (const row of rows) {
      const d = domainOf(row.email);
      if (d) set.add(d);
    }
  } catch (_) { /* non-fatal */ }
  internalDomainCache = set;
  return set;
}

function resetInternalDomains() {
  internalDomainCache = null;
}

function spamKeywordHit(subject, body) {
  const text = `${subject || ''}\n${body || ''}`.toLowerCase();
  return SPAM_KEYWORDS.find((k) => text.includes(k)) || null;
}

function junkSignals({ subject, body, senderPersonId, senderEmail, senderActive }) {
  const domain = domainOf(senderEmail);
  const domains = internalDomains();
  const keyword = spamKeywordHit(subject, body);
  return {
    externalDomain: !!domain && domains.size > 0 && !domains.has(domain),
    spamKeywords: !!keyword,
    keyword,
    unknownSender: !senderPersonId || senderActive === 0 || senderActive === false,
  };
}

// Decide whether an incoming message is junk. An account's allow-list (from a
// prior "Not junk") suppresses the external-domain and unknown-sender signals,
// but never a spam keyword hit.
function evaluateJunk({ subject, body, senderPersonId, senderEmail, senderActive, allowListed = false }) {
  const signals = junkSignals({ subject, body, senderPersonId, senderEmail, senderActive });
  if (allowListed) {
    signals.externalDomain = false;
    signals.unknownSender = false;
  }
  const reasons = [];
  if (signals.unknownSender) reasons.push('Unknown sender');
  if (signals.externalDomain) reasons.push('External domain');
  if (signals.spamKeywords) reasons.push(`Keyword: ${signals.keyword}`);
  return { junk: reasons.length > 0, reason: reasons.join(' · ') || null, signals };
}

// The value stored when an account marks a sender "Not junk": the domain when
// one is known, else the person id.
function senderRule({ senderPersonId, senderEmail }) {
  const d = domainOf(senderEmail);
  if (d) return { match_type: 'DOMAIN', value: d };
  if (senderPersonId) return { match_type: 'SENDER', value: String(senderPersonId) };
  return null;
}

module.exports = {
  primaryUserForPerson,
  immediateBossForTask,
  sendMail,
  domainOf,
  internalDomains,
  resetInternalDomains,
  spamKeywordHit,
  junkSignals,
  evaluateJunk,
  senderRule,
};
