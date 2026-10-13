import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import {
  parseTaskList, titleError, newBatch, previewRows, batchCounts, submitBatch,
} from '../public/paste-tasks.js';

const preview = (source) => ({ ...newBatch(), source, stage: 'preview', rows: previewRows(source) });

async function api(t) {
  const db = openDatabase(':memory:');
  const app = createServer(db, loadConfig({ AUTH_PASSWORD: 'paste-test-password', LOG_LEVEL: 'error' }));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    db.close();
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  const login = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'paste-test-password' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const sent = [];
  const create = async (key, payload, session = cookie) => {
    const body = JSON.stringify(payload);
    sent.push({ key, body });
    const res = await fetch(base + '/api/tickets', {
      method: 'POST', headers: {
        Cookie: session, 'Content-Type': 'application/json', 'Idempotency-Key': key,
      }, body,
    });
    const value = await res.json();
    if (!res.ok) throw Object.assign(new Error(value.error), { status: res.status });
    return value;
  };
  const tasks = () => db.prepare('SELECT id, title, queue FROM tickets ORDER BY id').all();
  return { create, sent, tasks };
}

test('paste parsing preserves order, repeated titles and prose while removing simple markers', () => {
  assert.deepEqual(parseTaskList(' \r\n- First\r\n  * Second\n+ Third\n• Fourth\n1. First\n2) Last\n-\n\n'),
    ['First', 'Second', 'Third', 'Fourth', 'First', 'Last']);
  assert.deepEqual(parseTaskList('2026 plans\n2.5 liters\nhttps://example.test\n[ ] Keep this text'),
    ['2026 plans', '2.5 liters', 'https://example.test', '[ ] Keep this text']);
});

test('paste limits reject oversize lists without truncating rows or long titles', () => {
  assert.equal(parseTaskList(Array(50).fill('Task').join('\n')).length, 50);
  assert.throws(() => parseTaskList(Array(51).fill('Task').join('\n')), /51 tasks.*50/);
  assert.throws(() => parseTaskList('x'.repeat(20001)), /20,000/);
  for (const source of ['', ' \n•\n1)\n', null]) assert.throws(() => parseTaskList(source));
  const long = 'x'.repeat(201);
  assert.equal(previewRows(long)[0].title, long);
  assert.match(titleError(long), /200.*201/);
  assert.equal(titleError(' ' + 'x'.repeat(200) + ' '), '');
  assert.match(titleError('   '), /title/);
});

test('invalid selected titles stop the entire save before any network or storage writes', async () => {
  const batch = preview('Valid\n' + 'x'.repeat(201));
  let writes = 0;
  await assert.rejects(submitBatch(batch, {
    persist: async () => { writes++; }, create: async () => { writes++; },
  }), /Edit or exclude/);
  assert.equal(writes, 0);
  assert.ok(batch.rows.every((row) => !row.payload));
});

test('lost committed response resumes in order with frozen keys and editable later rows', async (t) => {
  const { create, sent, tasks } = await api(t);
  const batch = preview('Repeated\nRepeated\nEdit me\n' + 'x'.repeat(201));
  batch.rows[3].included = false;
  const keys = batch.rows.map((row) => row.id);
  assert.equal(new Set(keys).size, 4);
  let saved;
  const persist = async (value) => { saved = structuredClone(value); };
  let requests = 0;
  await assert.rejects(submitBatch(batch, { persist, create: async (key, payload) => {
    const task = await create(key, payload);
    if (++requests === 2) throw new Error('Response lost after commit');
    return task;
  } }), /Response lost/);
  assert.equal(tasks().length, 2);
  assert.ok(saved.rows[0].ticket_id);
  assert.ok(saved.rows[1].payload);
  assert.equal(saved.rows[1].ticket_id, null);
  assert.equal(saved.rows[2].payload, null);
  const resumed = structuredClone(saved);
  resumed.rows[1].title = 'An attempted edit cannot change a started payload';
  resumed.rows[2].title = 'Edited remaining task';
  await submitBatch(resumed, { persist, create });
  assert.deepEqual(tasks().map((task) => task.title), ['Repeated', 'Repeated', 'Edited remaining task']);
  assert.ok(tasks().every((task) => task.queue === 'inbox'));
  assert.deepEqual(sent.map(({ key }) => key), [keys[0], keys[1], keys[1], keys[2]]);
  assert.equal(sent[1].body, sent[2].body);
  assert.deepEqual(batchCounts(resumed), { selected: 3, saved: 3, pending: 0 });
  await submitBatch(resumed, { persist, create });
  assert.equal(sent.length, 4, 'confirmed rows are never submitted again');
});

test('double submission clicks cannot start concurrent work on the same list', async (t) => {
  const { create, tasks } = await api(t);
  const batch = preview('Once');
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const deps = { persist: async () => {}, create: async (key, payload) => {
    entered();
    await gate;
    return create(key, payload);
  } };
  const first = submitBatch(batch, deps);
  await started;
  await assert.rejects(submitBatch(batch, deps), /already saving/);
  release();
  await first;
  assert.equal(tasks().length, 1);
});

test('a failed local payload write prevents a server write and preserves the retry identity', async (t) => {
  const { create, tasks, sent } = await api(t);
  const batch = preview('Keep this identity');
  const key = batch.rows[0].id;
  await assert.rejects(submitBatch(batch, {
    persist: async () => { throw new Error('Storage unavailable'); }, create,
  }), /Storage unavailable/);
  assert.equal(sent.length, 0);
  assert.equal(tasks().length, 0);
  assert.ok(batch.rows[0].payload);
  await submitBatch(batch, { persist: async () => {}, create });
  assert.equal(sent[0].key, key);
  assert.equal(tasks().length, 1);
});

test('reload after failure to persist a confirmation recovers exactly the same task', async (t) => {
  const { create, tasks, sent } = await api(t);
  const batch = preview('Confirmed on server');
  let saved;
  await assert.rejects(submitBatch(batch, { create, persist: async (value) => {
    if (value.rows[0].ticket_id) throw new Error('Confirmation could not be stored');
    saved = structuredClone(value);
  } }), /Confirmation could not be stored/);
  assert.equal(tasks().length, 1);
  assert.equal(saved.rows[0].ticket_id, null);
  await submitBatch(structuredClone(saved), { create, persist: async () => {} });
  assert.equal(tasks().length, 1);
  assert.equal(sent[0].key, sent[1].key);
  assert.equal(sent[0].body, sent[1].body);
});

test('session expiry freezes the interrupted row, then resumes without touching later rows', async (t) => {
  const { create, tasks, sent } = await api(t);
  const batch = preview('Interrupted\nLater');
  let saved;
  await assert.rejects(submitBatch(batch, {
    persist: async (value) => { saved = structuredClone(value); },
    create: (key, payload) => create(key, payload, ''),
  }), { status: 401 });
  assert.equal(tasks().length, 0);
  assert.ok(saved.rows[0].payload);
  assert.equal(saved.rows[1].payload, null);
  await submitBatch(structuredClone(saved), { create, persist: async () => {} });
  assert.equal(tasks().length, 2);
  assert.equal(sent[0].key, sent[1].key);
  assert.equal(sent[0].body, sent[1].body);
});

test('an unusable success response remains uncertain and is safe to recover', async (t) => {
  const { create, tasks } = await api(t);
  const batch = preview('Unreadable response');
  let saved;
  await assert.rejects(submitBatch(batch, {
    persist: async (value) => { saved = structuredClone(value); },
    create: async (key, payload) => { await create(key, payload); return {}; },
  }), /could not be confirmed/);
  assert.equal(saved.rows[0].ticket_id, null);
  assert.ok(saved.rows[0].payload);
  await submitBatch(saved, { create, persist: async () => {} });
  assert.equal(tasks().length, 1);
});

test('rejected requests never unlock a started row or replace its payload', async (t) => {
  const { create, tasks } = await api(t);
  const batch = preview('Original');
  const row = batch.rows[0];
  row.payload = { title: 'Original', queue: 'inbox' };
  await create(row.id, { title: 'Already committed with other content', queue: 'inbox' });
  await assert.rejects(submitBatch(batch, { create, persist: async () => {} }), { status: 400 });
  assert.deepEqual(row.payload, { title: 'Original', queue: 'inbox' });
  assert.equal(tasks().length, 1);
  assert.match(row.error, /different content/);
});
