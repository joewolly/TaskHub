# Chore skipping contract

Accepted for implementation on 2026-10-24. A skip is an explicit terminal
occurrence outcome, distinct from completion. It requires a reason and records
its timestamp, original due date, original assignee, and activity event.

- Calendar and fixed-interval chores advance past the skipped occurrence and
  current civil date while retaining their existing cadence.
- For after-completion chores, Joe selected a separate skip-date anchor: the
  next occurrence is due N days after the skip. No completion timestamp is set.
- Existing balancing counts assigned work, not completions. Keep skipped work
  in its original week's and four-week assignment totals and retain the last
  actual assignee for tie-breaking. A skip is no longer unfinished carryover.
  Existing assignments never move, and completion totals exclude skips.
- Skips are immutable through ordinary edits/reopening/deletion. A new independent
  task may be created through task reuse if the work becomes necessary again.
- The authenticated skip endpoint requires a revision and idempotency key.
  One transaction records the outcome, event, recurrence advancement and receipt.
  Retry cannot advance again or create a second unfinished occurrence.
- The new `skipped` status is readable/filterable/exportable but cannot be set
  by ordinary task creation or update. Old statuses retain their behavior.
  Skips appear in All and in chore/schedule history, not the completed-only Done list.
- Server snapshots/backups and ticket exports preserve skip fields. Offline
  skipping is not supported; regular offline completion cannot overwrite a skip.

Acceptance covers each recurrence family, early/overdue skips, changed revisions,
lost responses, repeated sweeps, downtime, reopen rejection, populated upgrades,
backup restoration, historical ownership, and distinct completion totals.
