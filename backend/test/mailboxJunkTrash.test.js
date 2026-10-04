const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.TMMS_DB = path.join(os.tmpdir(), `tmms-mail-${process.pid}-${Date.now()}.db`);

const express = require('express');
const { db, initSchema } = require('../db');
const { insertRow } = require('../util');
initSchema();

const { evaluateJunk, resetInternalDomains } = require('../mail');
const router = require('../routes/mailbox');

let server;
let base;
let CURRENT = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = CURRENT; next(); });
app.use('/api', router);

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => { if (server) server.close(); });

function person(first, email, active = 1) {
  return insertRow('person', { first_name: first, last_name: 'Test', role: 'STAFF', email, active });
}
function user(username, personId) {
  return insertRow('user', {
    username, password_hash: 'x', person_id: personId, role: 'FIELD', active: 1,
    created_at: new Date().toISOString(),
  });
}
function send(senderUserId, senderPersonId, recipientPersonId, subject, body) {
  const now = new Date().toISOString();
  const id = insertRow('message', {
    sender_user_id: senderUserId, sender_person_id: senderPersonId,
    recipient_person_id: recipientPersonId, subject, body, category: 'GENERAL',
    status: 'SENT', priority: 'NORMAL', created_at: now, updated_at: now, sent_at: now,
  });
  insertRow('message_recipient', { message_id: id, person_id: recipientPersonId, kind: 'TO', created_at: now });
  return id;
}
async function get(p, user) {
  CURRENT = user;
  const r = await fetch(base + p);
  return r.json();
}
async function put(p, body, user) {
  CURRENT = user;
  const r = await fetch(base + p, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
async function post(p, body, user) {
  CURRENT = user;
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
async function del(p, user) {
  CURRENT = user;
  const r = await fetch(base + p, { method: 'DELETE' });
  return r.json();
}

test('evaluateJunk flags unknown sender, external domain and keywords', () => {
  const internal = person('Pure Int', 'pure@tmms.local');
  user('pure1', internal);
  resetInternalDomains();
  const unknown = evaluateJunk({ senderPersonId: null });
  assert.strictEqual(unknown.junk, true);
  assert.match(unknown.reason, /Unknown sender/);
  const known = evaluateJunk({ senderPersonId: internal, senderEmail: 'pure@tmms.local', senderActive: 1 });
  assert.strictEqual(known.junk, false);
  const external = evaluateJunk({ senderPersonId: 999999, senderEmail: 'x@outside.example', senderActive: 1 });
  assert.ok(external.signals.externalDomain);
  const keyword = evaluateJunk({ senderPersonId: internal, senderEmail: 'pure@tmms.local', senderActive: 1, body: 'You have won the lottery' });
  assert.ok(keyword.junk);
  const rescued = evaluateJunk({ senderPersonId: null, allowListed: true });
  assert.strictEqual(rescued.junk, false);
});

test('classification files external/unknown mail to Junk and internal mail to Inbox', async () => {
  const recPerson = person('Rec', 'rec@tmms.local');
  const recUser = user('rec1', recPerson);
  const internalPerson = person('Int', 'boss@tmms.local');
  const internalUser = user('int1', internalPerson);
  resetInternalDomains();
  const unknownId = send(null, null, recPerson, 'Hello from nowhere', 'plain');
  const externalId = send(null, null, recPerson, 'Deal', 'click here now');
  const internalId = send(internalUser, internalPerson, recPerson, 'Weekly report', 'all good');

  const inbox = await get('/mailbox/folder?folder=mailinbox', { id: recUser, person_id: recPerson, role: 'FIELD' });
  const junk = await get('/mailbox/folder?folder=junk', { id: recUser, person_id: recPerson, role: 'FIELD' });
  const inboxIds = inbox.rows.map((r) => r.id);
  const junkIds = junk.rows.map((r) => r.id);
  assert.ok(inboxIds.includes(internalId));
  assert.ok(!inboxIds.includes(unknownId));
  assert.ok(junkIds.includes(unknownId) && junkIds.includes(externalId));
  assert.ok(!junkIds.includes(internalId));
  assert.ok(junk.rows.find((r) => r.id === externalId).junk_reason);
});

test('not-junk restores to Inbox and remembers the sender', async () => {
  resetInternalDomains();
  const recPerson = person('Rec2', 'rec2@tmms.local');
  const recUser = user('rec2', recPerson);
  const extPerson = person('Ext2', 'promo@outside.example');
  const outerId = send(null, extPerson, recPerson, 'Promo', 'newsletter body');
  const userObj = { id: recUser, person_id: recPerson, role: 'FIELD' };

  const junkBefore = await get('/mailbox/folder?folder=junk', userObj);
  assert.ok(junkBefore.rows.map((r) => r.id).includes(outerId));
  await put(`/mailbox/messages/${outerId}/junk`, { junk: false }, userObj);
  const inbox = await get('/mailbox/folder?folder=mailinbox', userObj);
  assert.ok(inbox.rows.map((r) => r.id).includes(outerId));
  const rules = await get('/mailbox/junk-rules', userObj);
  assert.ok(rules.length >= 1);
});

test('trash, restore and star move a message between folders', async () => {
  const recPerson = person('Rec3', 'rec3@tmms.local');
  const recUser = user('rec3', recPerson);
  const internal = person('Int3', 'int3@tmms.local');
  const internalUser = user('int3', internal);
  const id = send(internalUser, internal, recPerson, 'Note', 'body');
  const userObj = { id: recUser, person_id: recPerson, role: 'FIELD' };

  await put(`/mailbox/messages/${id}/star`, { starred: true }, userObj);
  await put(`/mailbox/messages/${id}/trash`, { trash: true }, userObj);
  let trash = await get('/mailbox/folder?folder=trash', userObj);
  assert.ok(trash.rows.map((r) => r.id).includes(id));
  let inbox = await get('/mailbox/folder?folder=mailinbox', userObj);
  assert.ok(!inbox.rows.map((r) => r.id).includes(id));

  await put(`/mailbox/messages/${id}/trash`, { trash: false }, userObj);
  inbox = await get('/mailbox/folder?folder=mailinbox', userObj);
  const row = inbox.rows.find((r) => r.id === id);
  assert.ok(row);
  assert.strictEqual(row.starred, true);
});

test('permanent delete is per-account and leaves the sender copy intact', async () => {
  const recPerson = person('Rec4', 'rec4@tmms.local');
  const recUser = user('rec4', recPerson);
  const senderPerson = person('Sender4', 'sender4@tmms.local');
  const senderUser = user('sender4', senderPerson);
  const id = send(senderUser, senderPerson, recPerson, 'Keep for sender', 'body');

  const recObj = { id: recUser, person_id: recPerson, role: 'FIELD' };
  await del(`/mailbox/messages/${id}`, recObj);
  const inbox = await get('/mailbox/folder?folder=mailinbox', recObj);
  assert.ok(!inbox.rows.map((r) => r.id).includes(id));

  const sent = await get('/mailbox/folder?folder=mailsent', { id: senderUser, person_id: senderPerson, role: 'FIELD' });
  assert.ok(sent.rows.map((r) => r.id).includes(id));
});

test('empty trash purges the caller only and counts reflect folders', async () => {
  const recPerson = person('Rec5', 'rec5@tmms.local');
  const recUser = user('rec5', recPerson);
  const internal = person('Int5', 'int5@tmms.local');
  const internalUser = user('int5', internal);
  const id = send(internalUser, internal, recPerson, 'Trash me', 'body');
  const userObj = { id: recUser, person_id: recPerson, role: 'FIELD' };
  await put(`/mailbox/messages/${id}/trash`, { trash: true }, userObj);
  const summary = await get('/mailbox/summary', userObj);
  assert.ok(summary.mail_trash_count >= 1);
  await post('/mailbox/trash/empty', {}, userObj);
  const trash = await get('/mailbox/folder?folder=trash', userObj);
  assert.ok(!trash.rows.map((r) => r.id).includes(id));
});

test('bulk junk and not_junk act on a selection', async () => {
  const recPerson = person('Rec6', 'rec6@tmms.local');
  const recUser = user('rec6', recPerson);
  const a = send(null, null, recPerson, 'A', 'hello');
  const b = send(null, null, recPerson, 'B', 'hello');
  const userObj = { id: recUser, person_id: recPerson, role: 'FIELD' };
  await get('/mailbox/folder?folder=mailinbox', userObj);
  await post('/mailbox/messages/bulk', { action: 'not_junk', ids: [a, b] }, userObj);
  const inbox = await get('/mailbox/folder?folder=mailinbox', userObj);
  const ids = inbox.rows.map((r) => r.id);
  assert.ok(ids.includes(a) && ids.includes(b));
});
