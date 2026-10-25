import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { runBackup, getBackupStatus } from '../src/backup.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

test('backup outcomes persist independently across restart and distinguish disabled, unknown, healthy, overdue and failed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'backup-status-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'main.db'); let db = openDatabase(path);
  const settings = { dir: join(dir, 'snapshots'), enabled: true, intervalHours: 1, keep: 3 };
  assert.equal(getBackupStatus(db).status, 'disabled');
  assert.equal(getBackupStatus(db, settings).status, 'unknown');
  await runBackup(db, settings);
  const good = getBackupStatus(db, settings);
  assert.equal(good.status, 'healthy'); assert.equal(good.restore_verified, false);
  assert.equal(getBackupStatus(db, settings, Date.parse(good.last_success_at) + 3900001).status, 'overdue');
  const bad = join(dir, 'not-a-directory'); await writeFile(bad, 'x');
  await assert.rejects(runBackup(db, { ...settings, dir: bad }));
  const failed = getBackupStatus(db, settings);
  assert.equal(failed.status, 'failed'); assert.equal(failed.last_success_at, good.last_success_at);
  assert.ok(!JSON.stringify(failed).includes(dir));
  db.close(); db = openDatabase(path);
  assert.deepEqual(getBackupStatus(db, settings), failed);
  await runBackup(db, settings);
  assert.equal(getBackupStatus(db, settings).status, 'healthy');
  assert.equal(getBackupStatus(db, settings).last_failure_at, failed.last_failure_at);
  db.close();
});

test('storage-full and permission failures are sanitized; failed status persistence is explicit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'backup-errors-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const db = openDatabase(':memory:'); t.after(() => db.close());
  for (const [code, expected] of [['ENOSPC','storage_full'], ['EACCES','permission_denied']]) {
    const adapter = { prepare: sql => db.prepare(sql), exec: () => { throw Object.assign(new Error('private path and secret'), { code }); } };
    await assert.rejects(runBackup(adapter, { dir }));
    const state = getBackupStatus(adapter, { dir });
    assert.equal(state.failure_code, expected); assert.ok(!JSON.stringify(state).includes('secret'));
  }
  const adapter = { prepare: sql => { if (sql.startsWith('UPDATE')) throw new Error('disk full'); return db.prepare(sql); }, exec: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } };
  await assert.rejects(runBackup(adapter, { dir }));
  assert.equal(getBackupStatus(adapter, { dir }).status_persisted, false);
});

test('backup status requires authentication and exposes no configured directory', async t => {
  const db = openDatabase(':memory:');
  const app = createServer(db, loadConfig({ AUTH_PASSWORD: 'backup-test-password', BACKUP_DIR: '/private/backups' }));
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => app.close(r)); db.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(base + '/api/backup/status')).status, 401);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'backup-test-password' }) });
  const response = await fetch(base + '/api/backup/status', { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } });
  const body = await response.text(); assert.equal(response.status, 200); assert.ok(!body.includes('/private')); assert.equal(JSON.parse(body).status, 'unknown');
});
