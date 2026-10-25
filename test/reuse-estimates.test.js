import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createTicket, getTicket, listTickets, updateTicket } from '../src/api/tickets.js';
import { savedViews } from '../src/api/planning.js';
import { submitOnce } from '../src/submissions.js';
import { exportEntity } from '../src/api/export.js';
import { reuseDraft } from '../public/task-reuse.js';
import { matchesTime } from '../public/time-estimates.js';

test('reuse whitelists content and creates task plus unchecked checklist atomically with durable retries', t => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const source = createTicket(db, { title: 'Pack', body: 'Instructions', tags: ['trip'], today: true, estimate_minutes: 15, checklist: ['Clothes\nand shoes', 'Passport'] });
  db.prepare('UPDATE checklist_items SET completed = 1 WHERE ticket_id = ?').run(source.id);
  const before = getTicket(db, source.id), draft = reuseDraft(before);
  assert.equal(draft.today_rank, undefined); assert.equal(draft.schedule_id, undefined);
  assert.equal(draft.priority, 'medium'); assert.equal(draft.due_date, ''); assert.deepEqual(draft.files, []);
  assert.deepEqual(draft.checklist, ['Clothes\nand shoes', 'Passport']);
  const payload = { title: draft.title, body: draft.body, checklist: draft.checklist, queue: 'inbox', estimate_minutes: draft.estimate_minutes };
  const submit = () => submitOnce(db, 'ticket', draft.id, JSON.stringify(payload), () => createTicket(db, payload), id => getTicket(db, id)).value;
  const copy = submit(); assert.equal(submit().id, copy.id);
  assert.equal(copy.today_rank, null); assert.equal(copy.queue, 'inbox');
  assert.ok(copy.checklist.every(step => !step.completed && !source.checklist.some(old => old.id === step.id)));
  assert.deepEqual(getTicket(db, source.id), before);
  assert.throws(() => createTicket(db, { title: 'Bad copy', checklist: ['Fine', ' '] }), /required/);
  assert.equal(listTickets(db, { status: 'all' }).length, 2);
  assert.throws(() => submitOnce(db, 'ticket', draft.id, '{}', () => null, id => getTicket(db, id)), /different content/);
});

test('time filters, saved views and offline matching include unknown estimates explicitly; exports preserve values', t => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  for (const estimate_minutes of [null, 5, 15, 30, 60]) createTicket(db, { title: `Estimate ${estimate_minutes}`, estimate_minutes });
  const all = listTickets(db);
  for (const include_unestimated of [true, false]) {
    const query = { max_minutes: '15', include_unestimated: String(include_unestimated) };
    const expected = all.filter(task => matchesTime(task, query)).map(t => t.id);
    assert.deepEqual(listTickets(db, query).map(t => t.id), expected);
    const view = savedViews(db, null, { name: randomUUID(), filters: query }, 'POST');
    assert.deepEqual(listTickets(db, view.filters).map(t => t.id), expected);
  }
  assert.equal(listTickets(db, { max_minutes: 15 }).length, 3);
  for (const value of [0, 10, -1, true, [], '15x']) assert.throws(() => updateTicket(db, all[0].id, { estimate_minutes: value }), /estimate/);
  assert.throws(() => listTickets(db, { max_minutes: 'oops' }), /estimate/);
  assert.match(exportEntity(db, { format: 'csv' }).body, /estimate_minutes/);
  assert.deepEqual(JSON.parse(exportEntity(db).body).map(t => t.estimate_minutes), [null,5,15,30,60]);
});

test('estimate migration upgrades populated prior schema without changing tasks or checklist identities', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'taskhub-estimates-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'test.db'); let db = openDatabase(file);
  const ticket = createTicket(db, { title: 'Existing task', checklist: ['Existing step'] });
  db.exec('ALTER TABLE tickets DROP COLUMN skipped_at; ALTER TABLE tickets DROP COLUMN skip_reason; DROP TABLE backup_status; ALTER TABLE tickets DROP COLUMN estimate_minutes; PRAGMA user_version = 10'); db.close();
  db = openDatabase(file);
  try { const upgraded = getTicket(db, ticket.id); assert.equal(upgraded.estimate_minutes, null); assert.deepEqual(upgraded.checklist, ticket.checklist); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
  finally { db.close(); }
});
