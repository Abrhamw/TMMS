process.env.LOG_LEVEL = 'error';
process.env.TMMS_DB = require('node:path').join(require('node:os').tmpdir(), `tmms-jobs-${process.pid}-${Date.now()}.db`);

const test = require('node:test');
const assert = require('node:assert');

const { db, initSchema } = require('../db');
initSchema();

const jobs = require('../jobs');

function jobRow(id) {
  return db.prepare('SELECT * FROM job WHERE id = ?').get(id);
}

test('enqueue stores a queued job and drain runs a registered handler', async () => {
  const seen = [];
  jobs.registerHandler('test.echo', async (payload, job) => { seen.push({ payload, id: job.id }); });
  const id = jobs.enqueue('test.echo', { n: 1 });
  assert.strictEqual(jobRow(id).status, 'QUEUED');
  const runs = await jobs.drain();
  assert.ok(runs >= 1);
  assert.deepStrictEqual(seen, [{ payload: { n: 1 }, id }]);
  assert.strictEqual(jobRow(id).status, 'SUCCEEDED');
  assert.ok(jobRow(id).finished_at);
});

test('a failing job retries then dead-letters at max attempts', async () => {
  jobs.registerHandler('test.boom', async () => { throw new Error('kaboom'); });
  const id = jobs.enqueue('test.boom', null, { maxAttempts: 3 });
  await jobs.runOnce();
  const first = jobRow(id);
  assert.strictEqual(first.status, 'RETRY_WAIT');
  assert.strictEqual(first.attempts, 1);
  assert.match(first.last_error, /kaboom/);
});

test('a job with a single allowed attempt dead-letters immediately', async () => {
  jobs.registerHandler('test.boom1', async () => { throw new Error('fatal'); });
  const id = jobs.enqueue('test.boom1', null, { maxAttempts: 1 });
  await jobs.runOnce();
  assert.strictEqual(jobRow(id).status, 'DEAD');
});

test('recoverStuck requeues a job whose lease expired', () => {
  const id = jobs.enqueue('test.stuck', null);
  db.prepare("UPDATE job SET status = 'RUNNING', locked_by = 'x', locked_until = ? WHERE id = ?")
    .run(new Date(Date.now() - 60000).toISOString(), id);
  const recovered = jobs.recoverStuck();
  assert.ok(recovered >= 1);
  assert.strictEqual(jobRow(id).status, 'RETRY_WAIT');
  assert.strictEqual(jobRow(id).locked_by, null);
});

test('dedupeKey collapses duplicate queued jobs but frees once settled', async () => {
  jobs.registerHandler('test.dedupe', async () => {});
  const first = jobs.enqueue('test.dedupe', null, { dedupeKey: 'once' });
  const second = jobs.enqueue('test.dedupe', null, { dedupeKey: 'once' });
  assert.strictEqual(first, second);
  await jobs.drain();
  const third = jobs.enqueue('test.dedupe', null, { dedupeKey: 'once' });
  assert.notStrictEqual(third, first);
});

test('dueRecurring enqueues at most once per interval', () => {
  let calls = 0;
  jobs.registerRecurring('test.rec', 1000, () => { calls += 1; return { calls }; });
  const before = db.prepare("SELECT COUNT(*) AS c FROM job WHERE kind = 'test.rec'").get().c;
  jobs.dueRecurring(100000);
  jobs.dueRecurring(100500);
  jobs.dueRecurring(101000);
  const after = db.prepare("SELECT COUNT(*) AS c FROM job WHERE kind = 'test.rec'").get().c;
  assert.strictEqual(after - before, 2);
  assert.strictEqual(calls, 2);
});

test('stats reports counts by status', () => {
  const snapshot = jobs.stats();
  assert.ok(snapshot.SUCCEEDED >= 2);
  assert.ok(snapshot.DEAD >= 1);
});
