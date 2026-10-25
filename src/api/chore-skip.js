import { transaction } from '../db.js';
import { civilDate, addDays } from '../dates.js';
import { nextOccurrence } from '../recurrence.js';
import { submitOnce } from '../submissions.js';
import { requiredText, ValidationError } from '../validate.js';
import { getTicket } from './tickets.js';
import { recordEvent } from './events.js';

export function skipChore(db, id, input, key, now = new Date()) {
  if (!key) throw new ValidationError('An Idempotency-Key is required to skip a chore');
  if (!Number.isSafeInteger(input.revision)) throw new ValidationError('A current task revision is required');
  const reason = requiredText(input.reason, 'Skip reason', 500);
  return submitOnce(db, `skip-chore-${id}`, key, JSON.stringify(input), () => transaction(db, () => {
    const task = getTicket(db, id);
    if (!task.is_chore) throw new ValidationError('Only chore occurrences can be skipped');
    if (task.status === 'skipped') {
      if (task.skip_reason !== reason) throw new ValidationError('This occurrence was already skipped with a different reason');
      return task;
    }
    if (!task.is_open) throw new ValidationError('This occurrence is already finished');
    if (task.revision !== input.revision) throw Object.assign(new ValidationError('This chore changed. Refresh before skipping it.'), { status: 409 });
    const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(task.schedule_id);
    if (!schedule?.recurrence || schedule.last_ticket_id !== task.id) throw new ValidationError('Only the current chore occurrence can be skipped');
    const rule = JSON.parse(schedule.recurrence);
    const today = civilDate(now, schedule.time_zone);
    const anchor = task.original_due_date || schedule.last_due || schedule.next_due;
    const next = rule.kind === 'after_completion' ? addDays(today, rule.days) : nextOccurrence(rule, anchor, today > anchor ? today : anchor);
    db.prepare("UPDATE tickets SET status = 'skipped', skipped_at = ?, skip_reason = ?, resolved_at = NULL, today_rank = NULL, updated_at = datetime('now') WHERE id = ?").run(now.toISOString(), reason, task.id);
    db.prepare("UPDATE schedules SET next_due = ?, updated_at = datetime('now') WHERE id = ?").run(next, schedule.id);
    recordEvent(db, task.id, 'skipped', null, reason);
    return getTicket(db, task.id);
  }), resourceId => getTicket(db, resourceId)).value;
}
