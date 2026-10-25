import test from 'node:test';
import assert from 'node:assert/strict';
import { randomId } from '../public/uuid.js';
import { newBatch, previewRows } from '../public/paste-tasks.js';

test('HTTP capture identities work without crypto.randomUUID', (t) => {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    getRandomValues: original.getRandomValues.bind(original),
  } });
  t.after(() => Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original }));
  const ids = [randomId(), newBatch().id, ...previewRows('First\nSecond').map(row => row.id)];
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Set(ids).size, ids.length);
});
