import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { configureDates } from '../src/dates.js';
import { createSchedule, getSchedule, getChoreRoster, runSchedules } from '../src/api/schedules.js';
import { createTicket, getTicket, listTickets, updateTicket, deleteTicket } from '../src/api/tickets.js';
import { skipChore } from '../src/api/chore-skip.js';
import { getStats } from '../src/api/stats.js';
import { projects } from '../src/api/planning.js';
import { exportEntity } from '../src/api/export.js';
import { snapshot, applyOperation } from '../src/api/sync.js';
import { runBackup } from '../src/backup.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

function setup(t, date = '2030-01-01') {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(date + 'T12:00:00Z') });
  const db = openDatabase(':memory:'); configureDates(db, 'UTC'); t.after(() => db.close()); return db;
}
function chore(db, due, recurrence = { kind: 'interval', days: 7 }, fields = {}) {
  const schedule = createSchedule(db, { title: 'Clean filter', next_due: due, recurrence, is_chore: true, ...fields });
  runSchedules(db, { today: due });
  return { schedule, task: getTicket(db, getSchedule(db, schedule.id).last_ticket_id) };
}
const payload = task => ({ reason: 'Not needed this time', revision: task.revision });

for (const scenario of [
  { name: 'weekly', due: '2030-01-01', rule: { kind: 'weekly', weekdays: [2,5] }, next: '2030-01-04' },
  { name: 'monthly date leap year', due: '2032-01-31', rule: { kind: 'monthly_date', day: 31 }, next: '2032-02-29' },
  { name: 'last weekday', due: '2030-01-27', rule: { kind: 'monthly_weekday', ordinal: 5, weekday: 0 }, next: '2030-02-24' },
  { name: 'fixed interval', due: '2030-01-01', rule: { kind: 'interval', days: 7 }, next: '2030-01-08' },
  { name: 'after completion', due: '2030-01-01', rule: { kind: 'after_completion', days: 10 }, next: '2030-01-11' },
]) test(`skip advances ${scenario.name} once, preserves ownership and never grants completion credit`, t => {
  const db = setup(t, scenario.due), { task, schedule } = chore(db, scenario.due, scenario.rule);
  const key = randomUUID(), body = payload(task);
  const skipped = skipChore(db, task.id, body, key);
  assert.equal(skipped.status, 'skipped'); assert.equal(skipped.resolved_at, null); assert.equal(skipped.is_open, false);
  assert.equal(skipped.assignee_id, task.assignee_id); assert.equal(skipped.original_due_date, task.original_due_date);
  assert.equal(getSchedule(db, schedule.id).next_due, scenario.next);
  for (let i=0; i<3; i++) { skipChore(db, task.id, body, key); runSchedules(db, { today: scenario.next }); }
  assert.equal(db.prepare("SELECT count(*) n FROM tickets WHERE schedule_id = ? AND status NOT IN ('resolved','closed','skipped')").get(schedule.id).n, 1);
  assert.equal(getTicket(db, task.id).events.filter(e => e.kind === 'skipped').length, 1);
  assert.ok(!listTickets(db, { status: 'done' }).some(t => t.id === task.id));
  assert.ok(!snapshot(db).tasks.some(t => t.id === task.id));
  assert.ok(!getStats(db).recently_resolved.some(t => t.id === task.id));
  assert.throws(() => updateTicket(db, task.id, { status: 'open' }), /immutable/);
  assert.throws(() => deleteTicket(db, task.id), /history/);
  assert.throws(() => skipChore(db, task.id, { ...body, reason: 'Changed' }, key), /different content/);
});

test('overdue completion-based skip anchors to the skip civil date; early calendar skip consumes its future occurrence', t => {
  const db = setup(t);
  const first = chore(db, '2030-01-01', { kind: 'after_completion', days: 7 });
  skipChore(db, first.task.id, payload(first.task), randomUUID(), new Date('2030-01-05T12:00:00Z'));
  assert.equal(getSchedule(db, first.schedule.id).next_due, '2030-01-12');
  const early = chore(db, '2030-01-04', { kind: 'weekly', weekdays: [5] });
  skipChore(db, early.task.id, payload(early.task), randomUUID(), new Date('2030-01-01T12:00:00Z'));
  assert.equal(getSchedule(db, early.schedule.id).next_due, '2030-01-11');
  runSchedules(db, { today: '2030-03-01' }); runSchedules(db, { today: '2030-03-01' });
  for (const s of [first, early]) assert.equal(db.prepare("SELECT count(*) n FROM tickets WHERE schedule_id = ? AND status NOT IN ('resolved','closed','skipped')").get(s.schedule.id).n, 1);
});

test('stale skips and ordinary status writes cannot bypass occurrence rules; skipped work has no project completion credit', t => {
  const db = setup(t); const project = projects(db, null, { name: 'Home' }, 'POST');
  const { task } = chore(db, '2030-01-01', undefined, { project_id: project.id });
  updateTicket(db, task.id, { title: 'Changed filter chore' });
  assert.throws(() => skipChore(db, task.id, payload(task), randomUUID()), /changed/);
  const current = getTicket(db, task.id);
  skipChore(db, task.id, payload(current), randomUUID());
  assert.equal(projects(db, project.id).completed, 0);
  assert.equal(getChoreRoster(db, { today: '2030-01-01' }).assignments[0].status, 'skipped');
  assert.throws(() => createTicket(db, { title: 'Fake skip', status: 'skipped' }), /explicit/);
  const normal = createTicket(db, { title: 'Normal' });
  assert.throws(() => updateTicket(db, normal.id, { status: 'skipped' }), /explicit/);
  assert.throws(() => skipChore(db, normal.id, payload(normal), randomUUID()), /Only chore/);
  const conflict = applyOperation(db, { id: randomUUID(), ticket_id: task.id, revision: current.revision, kind: 'edit', changes: { status: 'resolved' } });
  assert.equal(conflict.state, 'conflict');
  projects(db, project.id, {}, 'DELETE');
  assert.equal(getTicket(db, task.id).status, 'skipped');
  assert.equal(getTicket(db, task.id).project_id, null);
});

test('skip anchors use the app civil date across the UTC date boundary', t => {
  const db = setup(t); configureDates(db, 'America/Denver');
  const { task, schedule } = chore(db, '2030-01-01', { kind: 'after_completion', days: 7 });
  skipChore(db, task.id, payload(task), randomUUID(), new Date('2030-01-02T01:00:00Z'));
  assert.equal(getSchedule(db, schedule.id).next_due, '2030-01-08');
});

test('skip history, receipt and recurrence survive backup/restore, and exports distinguish skip from completion', async t => {
  const db = setup(t); const dir = await mkdtemp(join(tmpdir(), 'skip-restore-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { task, schedule } = chore(db, '2030-01-01'); const body = payload(task), key = randomUUID();
  skipChore(db, task.id, body, key);
  const backup = await runBackup(db, { dir }); const restored = openDatabase(backup.file);
  try {
    const retry = skipChore(restored, task.id, body, key);
    assert.equal(retry.skip_reason, body.reason); assert.equal(getSchedule(restored, schedule.id).next_due, '2030-01-08');
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const row = JSON.parse(exportEntity(restored, { status: 'skipped' }).body)[0];
    assert.equal(row.status, 'skipped'); assert.equal(row.resolved_at, null); assert.equal(row.skip_reason, body.reason); assert.equal(row.assignee_id, task.assignee_id);
    assert.match(exportEntity(restored, { format: 'csv' }).body, /skip_reason/);
  } finally { restored.close(); }
});

test('skip API authenticates, requires identity and recovers a repeated request without advancing twice', async t => {
  const db = setup(t); const { task, schedule } = chore(db, '2030-01-01');
  const app = createServer(db, loadConfig({ AUTH_PASSWORD: 'skip-test-password', APP_TIME_ZONE: 'UTC' }));
  await new Promise(r => app.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => app.close(r)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const path = base + `/api/tickets/${task.id}/skip`, body = JSON.stringify(payload(task));
  assert.equal((await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 401);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'skip-test-password' }) });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  assert.equal((await fetch(path, { method: 'POST', headers, body })).status, 400);
  headers['Idempotency-Key'] = randomUUID();
  for (let i=0; i<2; i++) { const response = await fetch(path, { method: 'POST', headers, body }); assert.equal(response.status, 200); assert.equal((await response.json()).status, 'skipped'); }
  assert.equal(getSchedule(db, schedule.id).next_due, '2030-01-08');
});
