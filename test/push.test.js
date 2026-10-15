import test from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { randomBytes, createECDH } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { createTicket, updateTicket } from '../src/api/tickets.js';
import { configureDates } from '../src/dates.js';
import { createServer } from '../src/server.js';
import { pushConfig, validateSubscription, saveSubscription, subscriptionSettings, messagesFor, sweepPush, DEFAULT_PUSH_SETTINGS } from '../src/push.js';
const keys = webpush.generateVAPIDKeys();
const config = { push: pushConfig({ WEB_PUSH_PUBLIC_KEY: keys.publicKey, WEB_PUSH_PRIVATE_KEY: keys.privateKey, WEB_PUSH_SUBJECT: 'mailto:test@example.com' }) };
function sub() { const ec = createECDH('prime256v1'); ec.generateKeys(); return { endpoint: 'https://web.push.apple.com/test', keys: { p256dh: ec.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }; }
test('push rejects incomplete configuration and non-provider destinations', () => {
  assert.throws(() => pushConfig({ WEB_PUSH_PUBLIC_KEY: 'partial' }), /together/);
  for (const endpoint of ['https://127.0.0.1/test', 'http://web.push.apple.com/test', 'https://web.push.apple.com.evil.test/', 'https://web.push.apple.com:8443/', 'https://user@web.push.apple.com/']) assert.throws(() => validateSubscription({ ...sub(), endpoint }), /endpoint/);
  assert.equal(validateSubscription(sub()).endpoint, 'https://web.push.apple.com/test');
});
test('daily delivery follows local time across daylight saving changes and deduplicates the badge', () => {
  const tasks = [{ id: 1, title: 'Task', today_rank: 0, due_date: '2026-11-01', waiting_on: 'Reply', follow_up_date: '2026-11-01' }];
  const prefs = { ...DEFAULT_PUSH_SETTINGS, individual: true };
  assert.equal(messagesFor(tasks, prefs, new Date('2026-11-01T15:59Z'), 'America/Denver').length, 0);
  const messages = messagesFor(tasks, prefs, new Date('2026-11-01T16:00Z'), 'America/Denver');
  assert.equal(messages.length, 3); assert.ok(messages.every(m => m.payload.badge === 1));
  assert.equal(messagesFor(tasks, { ...prefs, digest: false, individual: false }, new Date('2026-11-01T17:00Z'), 'America/Denver').length, 0);
});
test('persistent delivery retries, disable settings, and expired subscriptions', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close()); configureDates(db, 'America/Denver');
  const task = createTicket(db, { title: 'Due', due_date: '2026-10-15' });
  const device = saveSubscription(db, config, { subscription: sub() });
  const now = new Date('2026-10-15T16:00Z'); let calls = 0;
  const send = async () => { calls++; if (calls === 1) throw new Error('Network failure'); };
  await sweepPush(db, config, { now, send });
  await sweepPush(db, config, { now, send }); assert.equal(calls, 1);
  await sweepPush(db, config, { now: new Date(+now + 61000), send }); assert.equal(calls, 2);
  await sweepPush(db, config, { now: new Date(+now + 180000), send }); assert.equal(calls, 2);
  subscriptionSettings(db, device.id, { digest: false });
  await sweepPush(db, config, { now: new Date(+now + 86400000), send }); assert.equal(calls, 2);
  subscriptionSettings(db, device.id, { digest: true });
  await sweepPush(db, config, { now: new Date(+now + 86400000), send: async () => { throw { statusCode: 410 }; } });
  assert.equal(db.prepare('SELECT count(*) AS n FROM push_subscriptions').get().n, 0);
  updateTicket(db, task.id, { status: 'resolved' });
});
test('completing a task suppresses pending retry notifications', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const task = createTicket(db, { title: 'Due', due_date: '2026-10-15' });
  saveSubscription(db, config, { subscription: sub(), settings: { digest: false, individual: true } });
  const now = new Date('2026-10-15T20:00Z'); let calls = 0;
  const send = async () => { calls++; throw new Error('Unavailable'); };
  await sweepPush(db, config, { now, send }); updateTicket(db, task.id, { status: 'resolved' });
  await sweepPush(db, config, { now: new Date(+now + 3600000), send }); assert.equal(calls, 1);
});
test('subscription UUID routes support read, settings updates, and deletion', async t => {
  const db = openDatabase(':memory:');
  const server = createServer(db, { enabled: false, ...config });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/push/subscriptions`;
  const created = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub() }) });
  assert.equal(created.status, 201); const { id } = await created.json();
  assert.equal((await fetch(`${base}/${id}`)).status, 200);
  const updated = await fetch(`${base}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ digest: false, hour: 10 }) });
  assert.equal(updated.status, 200); assert.equal((await updated.json()).settings.hour, 10);
  assert.equal((await fetch(`${base}/${id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${base}/${id}`)).status, 404);
});
test('delivery stops after five failures and a changed deadline creates a fresh event', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const task = createTicket(db, { title: 'Due', due_date: '2026-10-14' });
  saveSubscription(db, config, { subscription: sub(), settings: { digest: false, individual: true } });
  let calls = 0; const send = async () => { calls++; throw new Error('Unavailable'); };
  const base = Date.parse('2026-10-15T16:00Z');
  for (let i = 0; i < 7; i++) await sweepPush(db, config, { now: new Date(base + i * 3600000), send });
  assert.equal(calls, 5);
  updateTicket(db, task.id, { due_date: '2026-10-13' });
  await sweepPush(db, config, { now: new Date(base + 7 * 3600000), send });
  assert.equal(calls, 6);
});
