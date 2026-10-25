# Roadmap feature verification

Local acceptance on 2026-10-24 covered Review Today, Do now, task reuse, time
estimates, backup status, and chore skipping together.

- `npm test`: 295 passing tests, including schema upgrades, authenticated HTTP,
  idempotency, recurrence/date boundaries, export, backup status and restoration.
- Playwright with installed Chrome and WebKit: desktop 1280×900 and mobile
  390×844. Review navigation does not mutate tasks; focus completion advances;
  stale revisions fail visibly; mobile pages fit the viewport.
- Injected lost responses after successful server writes: checklist and note
  recovery after reload, reuse submission after reload, and chore skip retry.
  Readback verified one result and no duplicate task, note, or skip event.
- Reuse retains the editable local draft and produces fresh unchecked checklist
  items; time filters handle unknown estimates explicitly; Settings displays
  backup status; skipped chores retain their reason and assignment without
  completion credit and cannot be reopened from their detail view.

The failure-injection browser runs disable service workers so Playwright can
intercept requests consistently. They do not prove installed-PWA update behavior.
Physical iPhone installation/push and production deployment were not performed.
Backup status does not claim that an operator has independently verified a restore.
