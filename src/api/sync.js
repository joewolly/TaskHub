import { createHash } from 'node:crypto';
import { transaction } from '../db.js';
import { listTickets, getTicket, updateTicket, addComment } from './tickets.js';
import { checklist, savedViews } from './planning.js';
import { dateFor, timeZoneFor } from '../dates.js';
import { getStats } from './stats.js';
import { ValidationError } from '../validate.js';

export function snapshot(db) {
  return transaction(db, () => ({
    tasks: listTickets(db).map(t => getTicket(db, t.id)),
    planning: { today: dateFor(db), time_zone: timeZoneFor(db) },
    views: savedViews(db), stats: getStats(db), synced_at: new Date().toISOString(),
  }));
}

// Receipts are independent of task foreign keys: a retry after deletion must
// still recover the original response rather than perform the operation again.
export function applyOperation(db, input, notifier) {
  if (!input || !/^[a-zA-Z0-9-]{16,100}$/.test(input.id || '')) throw new ValidationError('Invalid operation ID');
  if (!Number.isSafeInteger(input.ticket_id) || input.ticket_id < 1 || !Number.isSafeInteger(input.revision)) throw new ValidationError('Invalid task revision');
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  let completed = false;
  const response = transaction(db, () => {
    const receipt = db.prepare('SELECT * FROM sync_receipts WHERE id = ?').get(input.id);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new ValidationError('Operation ID already used with different content');
      return JSON.parse(receipt.response);
    }
    let current;
    try { current = getTicket(db, input.ticket_id); }
    catch (error) { if (error.status === 404) return { state: 'deleted' }; throw error; }
    if (current.revision !== input.revision) return { state: 'conflict', task: current };
    const changes = input.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new ValidationError('Changes required');
    if (input.kind === 'edit') {
      if (!Object.keys(changes).length || Object.keys(changes).some(k => !['title', 'body', 'status'].includes(k))) throw new ValidationError('This action requires a connection');
      if ('status' in changes && changes.status !== 'resolved') throw new ValidationError('Only completion is supported by offline sync');
      updateTicket(db, current.id, changes);
      completed = current.is_open && changes.status === 'resolved';
    } else if (input.kind === 'note') {
      if (Object.keys(changes).some(k => k !== 'body')) throw new ValidationError('Invalid note');
      addComment(db, current.id, changes);
    } else if (input.kind === 'check') {
      if (Object.keys(changes).some(k => !['item_id', 'completed'].includes(k)) || typeof changes.completed !== 'boolean') throw new ValidationError('Invalid checklist change');
      checklist(db, current.id, changes.item_id, { completed: changes.completed }, 'PATCH');
    } else throw new ValidationError('Unsupported operation');
    const result = { state: 'applied', task: getTicket(db, current.id) };
    db.prepare('INSERT INTO sync_receipts(id, fingerprint, response) VALUES (?, ?, ?)').run(input.id, fingerprint, JSON.stringify(result));
    return result;
  });
  if (completed) notifier?.sendDetached('ticket.resolved', response.task);
  return response;
}
