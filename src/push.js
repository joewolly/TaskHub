import webpush from 'web-push';
import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError } from './validate.js';
import { listTickets } from './api/tickets.js';
import { timeZoneFor } from './dates.js';

export const DEFAULT_PUSH_SETTINGS = { digest: true, individual: false, hour: 9, deadlines: true, overdue: true, followUps: true };
export function pushConfig(env) {
  const publicKey = env.WEB_PUSH_PUBLIC_KEY || '', privateKey = env.WEB_PUSH_PRIVATE_KEY || '', subject = env.WEB_PUSH_SUBJECT || '';
  if ([publicKey, privateKey, subject].some(Boolean) && ![publicKey, privateKey, subject].every(Boolean)) throw new Error('Set WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY, and WEB_PUSH_SUBJECT together');
  if (publicKey) {
    try { webpush.setVapidDetails(subject, publicKey, privateKey); }
    catch { throw new Error('Invalid Web Push VAPID configuration'); }
  }
  return { enabled: !!publicKey, publicKey, privateKey, subject };
}
export function validateSubscription(subscription) {
  let url;
  try { url = new URL(subscription?.endpoint); } catch { throw new ValidationError('Invalid push endpoint'); }
  const host = url.hostname;
  const allowed = host === 'web.push.apple.com' || host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !allowed || url.href.length > 2048) throw new ValidationError('Unsupported push service endpoint');
  const keys = subscription?.keys;
  if (!keys || !/^[A-Za-z0-9_-]+={0,2}$/.test(keys.p256dh || '') || !/^[A-Za-z0-9_-]+={0,2}$/.test(keys.auth || '') || Buffer.from(keys.p256dh, 'base64url').length !== 65 || Buffer.from(keys.auth, 'base64url').length !== 16) throw new ValidationError('Invalid push encryption keys');
  return { endpoint: url.href, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}
function settings(input = {}) {
  if (Object.keys(input).some(key => !(key in DEFAULT_PUSH_SETTINGS))) throw new ValidationError('Unknown notification setting');
  const result = { ...DEFAULT_PUSH_SETTINGS, ...input };
  if (!Number.isInteger(result.hour) || result.hour < 0 || result.hour > 23) throw new ValidationError('Choose an hour from 0 to 23');
  for (const key of ['digest', 'individual', 'deadlines', 'overdue', 'followUps']) if (typeof result[key] !== 'boolean') throw new ValidationError('Invalid notification preference');
  return result;
}
export function saveSubscription(db, config, input) {
  if (!config.push?.enabled) throw new ValidationError('Web Push is not configured on this server');
  const sub = validateSubscription(input.subscription), preferences = settings(input.settings);
  const old = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(sub.endpoint);
  const id = old?.id || randomUUID();
  db.prepare('INSERT INTO push_subscriptions(id, endpoint, subscription, settings) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription, settings=excluded.settings').run(id, sub.endpoint, JSON.stringify(sub), JSON.stringify(preferences));
  return { id, settings: preferences };
}
export function subscriptionSettings(db, id, input) {
  const row = db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id);
  if (!row) throw new NotFoundError('This device is not subscribed');
  if (input) db.prepare('UPDATE push_subscriptions SET settings=? WHERE id=?').run(JSON.stringify(settings(input)), id);
  return { id, settings: input ? settings(input) : JSON.parse(row.settings) };
}
export function removeSubscription(db, id) { db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id); }
function civilNow(now, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
export function attentionCount(tasks, today) {
  return tasks.filter(t => t.today_rank !== null || t.due_date && t.due_date <= today || t.waiting_on && t.follow_up_date && t.follow_up_date <= today).length;
}
export function messagesFor(tasks, prefs, now, zone) {
  const { date, hour } = civilNow(now, zone);
  if (hour < prefs.hour) return [];
  const badge = attentionCount(tasks, date), messages = [];
  const add = (key, title, body, url) => messages.push({ key, payload: { title, body, url, badge, tag: key } });
  if (prefs.digest && badge) {
    const focus = tasks.filter(t => t.today_rank !== null).length;
    const deadlines = tasks.filter(t => t.due_date && t.due_date <= date).length;
    const followups = tasks.filter(t => t.waiting_on && t.follow_up_date && t.follow_up_date <= date).length;
    add(`digest:${date}`, 'Your Task Hub day', `${focus} in Today · ${deadlines} due or overdue · ${followups} follow-ups`, '/#/');
  }
  if (prefs.individual) for (const task of tasks) {
    const url = `/#/tickets/${task.id}`;
    if (prefs.deadlines && task.due_date === date) add(`due:${task.id}:${task.due_date}`, 'Due today', task.title, url);
    if (prefs.overdue && task.due_date && task.due_date < date) add(`overdue:${task.id}:${task.due_date}`, 'Task overdue', task.title, url);
    if (prefs.followUps && task.waiting_on && task.follow_up_date && task.follow_up_date <= date) add(`follow:${task.id}:${task.follow_up_date}`, 'Time to follow up', `${task.title} · ${task.waiting_on}`, url);
  }
  return messages;
}
const running = new WeakSet();
export async function sweepPush(db, config, { now = new Date(), send = webpush.sendNotification } = {}) {
  if (!config.push?.enabled || running.has(db)) return;
  running.add(db);
  try {
    const tasks = listTickets(db);
    for (const row of db.prepare('SELECT * FROM push_subscriptions').all()) {
      const eligible = messagesFor(tasks, JSON.parse(row.settings), now, timeZoneFor(db));
      for (const message of eligible) db.prepare('INSERT OR IGNORE INTO push_deliveries(subscription_id,event_key,payload) VALUES (?,?,?)').run(row.id, message.key, JSON.stringify(message.payload));
      // Re-evaluate eligibility before retrying, so completed tasks and disabled
      // categories never produce a stale alert from the durable delivery queue.
      for (const message of eligible) {
        const delivery = db.prepare('SELECT * FROM push_deliveries WHERE subscription_id=? AND event_key=?').get(row.id, message.key);
        if (!delivery || delivery.delivered_at || delivery.attempts >= 5 || delivery.next_attempt > now.getTime()) continue;
        db.prepare('UPDATE push_deliveries SET attempts=attempts+1, next_attempt=? WHERE subscription_id=? AND event_key=?').run(now.getTime() + Math.min(3600000, 60000 * 2 ** delivery.attempts), row.id, message.key);
        try {
          await send(validateSubscription(JSON.parse(row.subscription)), JSON.stringify(message.payload), pushOptions(config));
          db.prepare('UPDATE push_deliveries SET delivered_at=? WHERE subscription_id=? AND event_key=?').run(now.toISOString(), row.id, message.key);
        } catch (error) {
          if ([404, 410].includes(error.statusCode)) { removeSubscription(db, row.id); break; }
          // No endpoints, keys, or personal notification text in logs.
        }
      }
    }
  } finally { running.delete(db); }
}
function pushOptions(config) {
  return { TTL: 3600, timeout: 10000, vapidDetails: { subject: config.push.subject, publicKey: config.push.publicKey, privateKey: config.push.privateKey } };
}
export async function testPush(db, config, id) {
  if (!config.push?.enabled) throw new ValidationError('Web Push is not configured');
  const row = db.prepare('SELECT * FROM push_subscriptions WHERE id=?').get(id);
  if (!row) throw new NotFoundError('This device is not subscribed');
  try {
    await webpush.sendNotification(validateSubscription(JSON.parse(row.subscription)), JSON.stringify({ title: 'Task Hub is ready', body: 'Reminders will appear here.', url: '/#/', tag: 'taskhub-test' }), pushOptions(config));
  } catch (error) {
    if ([404, 410].includes(error.statusCode)) removeSubscription(db, id);
    throw new ValidationError('The push service could not deliver the test. Try enabling notifications again.');
  }
  return { sent: true };
}
