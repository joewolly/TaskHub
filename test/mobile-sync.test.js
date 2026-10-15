import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createTicket, getTicket, updateTicket, deleteTicket, addComment, bulkUpdateTickets } from '../src/api/tickets.js';
import { checklist, orderToday } from '../src/api/planning.js';
import { applyOperation, snapshot } from '../src/api/sync.js';
import { createSchedule, runSchedules, getSchedule } from '../src/api/schedules.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const open = t => { const db = openDatabase(':memory:'); t.after(() => db.close()); return db; };
const edit = (task, changes, kind = 'edit') => ({ id: randomUUID(), ticket_id: task.id, revision: task.revision, kind, changes });
test('lost responses retry once; operation IDs cannot be reused with different content', t => {
  const db = open(t), task = createTicket(db, { title: 'Offline task' });
  const op = edit(task, { body: 'A note' }, 'note');
  const first = applyOperation(db, op);
  assert.equal(first.state, 'applied');
  assert.deepEqual(JSON.parse(JSON.stringify(applyOperation(db, op))), JSON.parse(JSON.stringify(first)));
  assert.equal(getTicket(db, task.id).comments.length, 1);
  assert.throws(() => applyOperation(db, { ...op, changes: { body: 'Different' } }), /already used/);
  deleteTicket(db, task.id);
  assert.deepEqual(JSON.parse(JSON.stringify(applyOperation(db, op))), JSON.parse(JSON.stringify(first)));
});
test('concurrent edits return the server version and do not overwrite it', t => {
  const db = open(t), task = createTicket(db, { title: 'Before' });
  updateTicket(db, task.id, { title: 'Changed elsewhere' });
  const result = applyOperation(db, edit(task, { title: 'Local' }));
  assert.equal(result.state, 'conflict');
  assert.equal(result.task.title, 'Changed elsewhere');
  const accepted = applyOperation(db, edit(result.task, { title: 'Local' }));
  assert.equal(accepted.task.title, 'Local');
  deleteTicket(db, task.id);
  assert.equal(applyOperation(db, edit(accepted.task, { title: 'Recovered' })).state, 'deleted');
});
test('existing edit, bulk, note, checklist, and Today paths advance task revisions', t => {
  const db = open(t); let task = createTicket(db, { title: 'Task' });
  for (const change of [
    () => updateTicket(db, task.id, { title: 'New' }),
    () => addComment(db, task.id, { body: 'Note' }),
    () => checklist(db, task.id, null, { title: 'Step' }, 'POST'),
    () => bulkUpdateTickets(db, { ids: [task.id], priority: 'high' }),
    () => updateTicket(db, task.id, { today: true }),
    () => orderToday(db, { ids: [task.id] }),
  ]) {
    const previous = getTicket(db, task.id).revision; change();
    assert.ok(getTicket(db, task.id).revision > previous);
  }
  task = getTicket(db, task.id);
  const op = edit(task, { item_id: task.checklist[0].id, completed: true }, 'check');
  assert.equal(applyOperation(db, op).task.checklist_completed, 1);
  assert.equal(applyOperation(db, op).task.checklist_completed, 1);
});
test('snapshot contains all active tasks, not completed history or attachment bytes', t => {
  const db = open(t);
  createTicket(db, { title: 'Active', queue: 'someday' });
  createTicket(db, { title: 'Done', status: 'closed' });
  const data = snapshot(db);
  assert.deepEqual(data.tasks.map(t => t.title), ['Active']);
  assert.ok(data.planning.today); assert.ok(data.synced_at);
});
test('offline completion retries do not advance recurrence twice', t => {
  const db = open(t);
  const schedule = createSchedule(db, { title: 'Routine', interval_days: 1, recurrence: { kind: 'after_completion', days: 1 }, next_due: '2026-01-01' });
  const fired = runSchedules(db);
  const task = getTicket(db, fired[0].ticket.id);
  const op = edit(task, { status: 'resolved' });
  applyOperation(db, op);
  const after = getSchedule(db, schedule.id);
  applyOperation(db, op);
  assert.deepEqual(getSchedule(db, schedule.id), after);
});
test('sync and push APIs require authentication; shell contains no private data', async t => {
  const db = open(t), server = createServer(db, loadConfig({ AUTH_PASSWORD: 'testing-password' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of ['/api/sync/snapshot', '/api/push/config', '/api/push/subscriptions/test']) assert.equal((await fetch(base + path)).status, 401);
  assert.equal((await fetch(base + '/api/sync/operations', { method: 'POST' })).status, 401);
  const shell = await fetch(base + '/app-shell.html'); assert.equal(shell.status, 200);
  assert.match(await shell.text(), /Task Hub/);
});
