import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { log, errorFields } from './log.js';

const PREFIX = 'homelab-';
const SUFFIX = '.db';

/** Matches only the files this module writes, so pruning cannot touch anything else. */
const BACKUP_NAME = /^homelab-\d{8}T\d{6}\.\d{3}Z\.db$/;
const failures = new WeakMap();
const running = new WeakMap();

function failureCode(error) {
  if (error.code === 'ENOSPC' || error.errcode === 13) return 'storage_full';
  if (['EACCES', 'EPERM'].includes(error.code)) return 'permission_denied';
  return 'backup_failed';
}

export function getBackupStatus(db, settings = {}, now = Date.now()) {
  const persisted = db.prepare('SELECT last_success_at, last_failure_at, failure_code, last_outcome, last_bytes FROM backup_status WHERE id = 1').get();
  const temporary = failures.get(db);
  const state = { ...persisted, ...temporary };
  const enabled = settings.enabled ?? Boolean(settings.dir);
  const intervalHours = settings.intervalHours || 24;
  const due = state.last_success_at ? Date.parse(state.last_success_at) + intervalHours * 3600000 : null;
  const status = !enabled ? 'disabled' : state.last_outcome === 'failure' ? 'failed' : due === null ? 'unknown' : now > due + 300000 ? 'overdue' : 'healthy';
  return { ...state, status, enabled, interval_hours: intervalHours, keep: settings.keep ?? 7,
    next_due_at: due === null ? null : new Date(due).toISOString(),
    status_persisted: !temporary, restore_verified: false };
}

/**
 * Snapshots the database with VACUUM INTO, which is safe to run against a live
 * WAL database — unlike copying the file, which can capture a torn state.
 * Returns the file written, or null when backups are switched off.
 */
export async function runBackup(db, settings = {}) {
  if (!settings.dir) return null;
  if (running.has(db)) return running.get(db);
  const attempt = (async () => {
    try {
      const result = await writeSnapshot(db, settings);
      db.prepare("UPDATE backup_status SET last_success_at = ?, last_bytes = ?, last_outcome = 'success' WHERE id = 1").run(new Date().toISOString(), result.bytes);
      failures.delete(db);
      return result;
    } catch (error) {
      const failure = { last_failure_at: new Date().toISOString(), failure_code: failureCode(error), last_outcome: 'failure' };
      try {
        db.prepare("UPDATE backup_status SET last_failure_at = ?, failure_code = ?, last_outcome = 'failure' WHERE id = 1").run(failure.last_failure_at, failure.failure_code);
        failures.delete(db);
      } catch { failures.set(db, failure); }
      throw error;
    } finally { running.delete(db); }
  })();
  running.set(db, attempt);
  return attempt;
}

async function writeSnapshot(db, { dir, keep = 7 } = {}) {
  if (!dir) return null;

  await mkdir(dir, { recursive: true });

  const name = `${PREFIX}${new Date().toISOString().replace(/[-:]/g, '')}${SUFFIX}`;
  const target = join(dir, name);

  // VACUUM INTO takes no bound parameters, so the path is inlined. It is built
  // from a timestamp we generate, never from input, and quotes are doubled for
  // the SQL string literal regardless.
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);

  const { size } = await stat(target);
  const pruned = await prune(dir, keep);

  log.info('backup written', { file: target, bytes: size, pruned: pruned.length });
  return { file: target, bytes: size, pruned };
}

/** Keeps the newest `keep` snapshots and deletes the rest. */
async function prune(dir, keep) {
  const names = (await readdir(dir)).filter((name) => BACKUP_NAME.test(name)).sort();
  const stale = names.slice(0, Math.max(0, names.length - keep));

  const removed = [];
  for (const name of stale) {
    try {
      await unlink(join(dir, name));
      removed.push(name);
    } catch (err) {
      log.warn('could not prune backup', { file: name, ...errorFields(err) });
    }
  }
  return removed;
}

/**
 * Runs a backup without letting a failure reach the caller — the timer that
 * drives this must survive a full disk or a bad mount.
 */
export async function runBackupSafely(db, settings) {
  try {
    return await runBackup(db, settings);
  } catch (err) {
    log.error('backup failed', errorFields(err));
    return null;
  }
}
