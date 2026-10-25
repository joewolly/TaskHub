import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadCache } from '../public/read-cache.js';

test('concurrent tab reads share one request and receive independent results', async () => {
  const cache = createReadCache();
  let calls = 0;
  const load = async () => { calls++; return { tasks: ['First'] }; };
  const [first, second] = await Promise.all([cache.get('/tickets', load), cache.get('/tickets', load)]);
  first.tasks.push('Local edit');
  assert.deepEqual(second.tasks, ['First']);
  assert.deepEqual((await cache.get('/tickets', load)).tasks, ['First']);
  assert.equal(calls, 1);
});

test('expired reads refresh and failed requests can be retried immediately', async () => {
  let time = 0, calls = 0;
  const cache = createReadCache({ ttlMs: 5, now: () => time });
  const load = async () => ++calls;
  assert.equal(await cache.get('/views', load), 1);
  time = 5;
  assert.equal(await cache.get('/views', load), 2);
  await assert.rejects(cache.get('/stats', () => { throw new Error('Temporary failure'); }), /Temporary failure/);
  assert.equal(await cache.get('/stats', load), 3);
});

test('invalidation during an old request cannot overwrite a newer result', async () => {
  const cache = createReadCache();
  let finish;
  const old = cache.get('/tickets', () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  cache.clear();
  assert.deepEqual(await cache.get('/tickets', async () => ['Updated']), ['Updated']);
  finish(['Old']);
  await old;
  assert.deepEqual(await cache.get('/tickets', () => { throw new Error('Unexpected request'); }), ['Updated']);
});

test('varying filters cannot grow the navigation cache without bound', async () => {
  const cache = createReadCache({ maxEntries: 2 });
  for (const key of ['one', 'two', 'three']) await cache.get(key, async () => key);
  assert.equal(await cache.get('one', async () => 'Reloaded'), 'Reloaded');
});
