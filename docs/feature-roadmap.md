# Practical feature roadmap

Status: **proposal for Joe's review**. Priorities and milestone boundaries below
are recommendations, not agreed commitments or delivery dates. This document
changes no application behavior.

Reviewed against main at
[`1fe26fc7dc056cdd6f9b9f013291420f9ab89914`](https://github.com/joewolly/TaskHub/commit/1fe26fc7dc056cdd6f9b9f013291420f9ab89914)
on 2026-10-03.

## Direction

Make capturing something easier, then help finish work already captured. Preserve
the dependency-free Node application, one SQLite database, and shared sign-in.
Each feature should earn its place by removing an everyday obstacle.

Today ordering, snooze, Waiting/follow-ups, checklists, projects, saved views,
routines, offline drafts, phone capture, and two-person chore rotation already
exist. The dashboard already includes Today focus, Needs attention, Next up, and
quick capture. These proposals extend those workflows; they do not introduce a
second planning system. See [current planning behavior](planning.md).

## Nine ideas

Effort is relative: **S** is a bounded interface change, **M** adds a workflow
with recovery cases, and **L** crosses recurrence or privacy contracts. These
are scope estimates, not calendar estimates; browser work and compatibility
checks are included.

| Idea | Concrete value and first scope | Effort / main risk | Recommended placement |
| --- | --- | --- | --- |
| 1. Photos that fit | Resize a browser-decodable photo locally, preview the result, and attach it within the existing 1 MB limit. Capture a repair or receipt without a separate image editor. | M: orientation, image quality, device memory, storage errors | Milestone 1 |
| 2. Paste a list | Turn one pasted list into editable task rows, then explicitly save them to Inbox with safe partial retries. Capture a copied text checklist in one visit. | M: ambiguous text, partial success, duplicate submissions | Milestone 1 |
| 3. Short daily review | An optional guided pass over dates, follow-ups, older Inbox items, and Today choices. Make a few decisions without inspecting every list. | S-M: hidden mutations, date boundaries, interrupting ordinary use | Milestone 2 |
| 4. Do now | Open one selected Today task with its checklist, notes, and Done/Next/Back controls. Keep the next useful action in view while doing the work. | S-M: stale task state and repeated saves | Milestone 2 |
| 5. Use this task again | Start an independent draft from a useful task and its unchecked checklist. Reuse a packing list or repair procedure without making it recurring. | M: accidentally copying history, assignment, or recurrence | Milestone 3 |
| 6. Time available | Optional 5/15/30/60-minute estimates and a filter, with unestimated tasks still available. Find something suitable for a short gap. | M: new data/filter/export contract and estimate upkeep | Backlog |
| 7. Skip one chore | Explicitly skip an occurrence with a reason and history, without completion credit. Record that a chore was unnecessary this time. | L: cadence, fairness, one unfinished occurrence | Conditional Milestone 3 |
| 8. Backup status | Show the last successful snapshot, last failure, overdue, unknown, and disabled states. See when recovery preparation needs attention. | M: persistent status, restart behavior, false reassurance | Backlog |
| 9. Today pocket copy | Explicitly save an expiring, read-only Today snapshot for a brief loss of connection. Consult a chosen task or checklist offline. | L: local private data, expiry, sign-out limits | Conditional backlog |

## Recommended milestone 1: easier capture

Deliver photo preparation and list capture as **two independent small PRs**.
Both build on existing device-local drafts and explicit submission. No server
schema change is expected. Finish the first feature before expanding its scope.

### 1. Photo preparation

Offer an optional local resize/compress step for JPEG, PNG, and WebP images
the browser can decode. Show original and resulting size, dimensions, and a
visual preview before accepting the converted file. Keep the server ceiling at
**1,048,576 bytes per file** and its current allowlist. Apply the same preparation
behavior wherever users add attachments, including the standalone capture page.

Acceptance criteria:

- A representative oversized phone photo becomes a nonempty accepted file at
  or below the cap; an already acceptable file remains unchanged unless the
  user chooses conversion. The original file on the device is retained.
- Portrait and landscape images have the expected orientation. Fine text is
  readable in the preview; users can cancel or choose another file.
- Conversion and preview work offline after the capture shell is installed.
  Only the accepted output enters the draft and ordinary upload/retry path.
  Freeze output bytes before its attachment idempotency key is used.
- Corrupt/unsupported images, excessive decoded dimensions, insufficient local
  storage, and an unattainable size target produce a recoverable error.
  Do not claim a file was saved or uploaded when it was not.
- Validate the real iPhone Safari/home-screen flow and a desktop browser with
  large images, reloads, interrupted uploads, and expired sessions.

Dependencies and limits: prototype decoding/orientation and bounded memory use
first. Keep PDFs, text files, and GIFs on the existing upload path. HEIC conversion,
OCR, cloud image processing, and guaranteed metadata removal are outside this
milestone. State what is converted; make no GPS/EXIF removal promise without a
separate verified specification.

### 2. Paste-list capture

Provide an explicit **Paste as tasks** action alongside ordinary notes paste.
The first version handles one task per nonempty line with optional leading
bullets/numbers. Preview up to **50 rows**, preserving order, before submission.
Users can edit, remove, or exclude rows; show the final count and Inbox destination.
Do not infer priorities, dates, projects, or checklist nesting from prose.

Acceptance criteria:

- Blank lines and simple list markers are handled predictably. Titles must meet
  the existing 200-character limit. Oversize input is flagged for editing;
  neither long titles nor rows beyond the limit are silently truncated.
- Canceling the preview creates no server tasks. Preview edits and exclusions
  survive a page reload as a device-local batch draft.
- Each included row has a stable key and a frozen submission payload once its
  submission starts. Submit sequentially through existing task creation, retain
  each confirmed task ID, and resume remaining/uncertain rows safely.
- A lost response, partial failure, double click, reload, or sign-in interruption
  creates exactly one task per submitted row, even when local confirmation was
  not persisted. An uncertain row stays locked until its outcome is recovered;
  unstarted rows remain editable.
- Clearly distinguish saved, pending, and failed rows. Discarding the remainder
  retains saved tasks. Identical titles are allowed when explicitly selected:
  retry deduplication uses submission identity, not title text.

Dependencies and limits: extend local draft records compatibly; older single
drafts must remain readable and resumable. Reuse existing idempotency behavior
rather than adding a bulk server endpoint. No CSV import, automatic submission
on reconnect, attachments per batch row, or natural-language date parser.

Milestone exit: use synthetic data to demonstrate both capture paths, including
a partially completed batch reopened after reconnecting. Confirm old drafts,
ordinary notes paste, and existing attachment retries still work. If the photo
prototype cannot reliably meet the cap on target devices, ship list capture
independently and keep photo conversion behind its acceptance gate.

## Recommended milestone 2: choose, then do

Implement the voluntary review first and Do now second, reusing current Today
selections and checklist APIs. Neither requires a second queue, a daily reset,
or a new server schema. Milestone 2 can proceed independently of photo work.

### 3. Voluntary daily review

Add a user-invoked **Review Today** action. Present a short sequence: deadlines
and due follow-ups, a bounded page of older Inbox/actionable Next tasks, then
the current ordered Today list. Offer existing choices such as Add to Today,
Next, Someday, Snooze, or leave unchanged, and permit stopping at any point.

Acceptance criteria:

- Opening, skipping, or closing the review writes nothing. Each selected action
  saves independently and reports failure; returning after interruption reads
  the actual server state.
- Show deadlines separately from focus choices, including deadlines on Inbox
  and Someday tasks. Respect snooze and follow-up visibility and use
  `APP_TIME_ZONE` civil dates for date boundaries.
- Today selections persist across days in their existing order. Review never
  moves deadlines, clears selections at midnight, or silently promotes tasks.
  Explicit Add to Today retains its existing Next/clear-snooze/clear-waiting
  semantics and explains them before affecting a waiting or snoozed task.
- Keyboard and touch users can make the same decisions. A long Inbox does not
  require reviewing everything to exit. Reloading does not replay actions.

Scope excludes mandatory daily rituals, streaks, scores, automated recommendations,
and a replacement dashboard. No review-completion history is needed initially.

### 4. Do now

From Today, let the user choose one task or start with the first actionable
selection. Show its title, checklist, notes, and explicit **Done**, **Next**,
and **Back to Today** controls. Next only changes the displayed task; it does
not complete, reorder, or remove the current task.

Acceptance criteria:

- Follow existing Today order. Checklist checks save through current APIs and
  never complete the parent automatically. Done uses the normal completion
  action, including existing recurring-task behavior.
- A failed note or checklist save retains the user's input and reports the
  result. Prevent duplicate note writes when retrying an uncertain submission;
  review whether comment submission needs an additive idempotency contract.
- Repeated/interrupted Done actions do not create duplicate successors. Read
  current server state before advancing; another device completing, removing,
  or deleting the task yields a clear refresh path.
- Back returns to Today with its selections/order intact. An empty list has
  an obvious exit. Opening this view adds no new status or automatic timer.

Milestone exit: demonstrate review into Do now with synthetic tasks, an incomplete
checklist, waiting/snoozed work, a recurring task, and a second browser changing
Today. Offline users retain capture access; these existing-task workflows remain
online until a separately approved pocket-copy feature changes that boundary.

## Recommended milestone 3: reuse, then consider exceptions

### 5. Use this task again

Deliver reuse as its own PR. Offer a previewed independent draft that copies
title, body, tags, and unchecked checklist steps. Let the user explicitly keep
or change project/device references. Save it to Inbox when submitted.

Acceptance criteria:

- Use fresh task/checklist/submission identities. Reset status to open, priority
  to the normal capture default, and dates, Today, Waiting, snooze, assignee,
  completion markers, recurrence linkage, and history.
- Do not copy comments, attachments, or reference links in this first version.
  The original task and its routine/chore are unchanged.
- Checklist steps arrive exactly once after a lost response or partial failure,
  all unchecked. Creation plus initial checklist must have a recoverable,
  idempotent contract; decide an additive atomic-create extension before coding,
  since current task creation does not create a checklist from draft input.
- Preview/cancel works without creating a server task. Draft recovery works
  offline; if a copied project/device disappeared, explain it and let the user
  correct the reference without duplicate creation.

No saved-template library or template administration is needed.

### 7. Skip one chore: design gate

Treat this as a **conditional follow-on**, not a requirement to finish task
reuse or a commitment to change the chore model. First agree the occurrence
outcome and recurrence/fairness rules in a small design PR.

Decisions required before implementation:

- For calendar/fixed-interval rules, decide which occurrence is consumed and
  which future date follows. For after-completion rules, agree a separate
  skip anchor, or explicitly leave skipping unsupported; a skip is not a
  completion and cannot silently start the completion interval.
- Define how skipped work affects weekly load, carryovers, and rotation ties.
  It receives no completion credit. Preserve already assigned owners and
  historical accounting; never rebalance past assignments automatically.
- Design an auditable occurrence outcome with a reason and timestamp, compatible
  with existing task statuses/API clients. Do not simulate a skip by deleting
  a task or recording a false completion. Include exports and backup recovery.

Acceptance gate for any later implementation: one explicit skip has one durable
outcome; repeated requests/sweeps, restart, downtime, reopening, and each
supported recurrence family produce no duplicate or second unfinished
occurrence. Skipped, completed, and overdue outcomes remain distinguishable.
Keep the two-person shared-login model and avoid person-specific alerts.

Milestone exit: reuse a completed source twice into independent tasks, including
an interrupted submission with checklist steps. Confirm the source and its
recurrence are unchanged and old drafts still resume. Chore skipping proceeds
only after its design and recurrence/fairness acceptance gates pass.

## Ranked backlog: revisit after daily use

### 6. Time available

First backlog recommendation: optional nullable estimates of 5/15/30/60 minutes
on tasks, with a maximum-time filter in Next/Today and saved views. Always show
an explicit way to include unestimated tasks; never equate missing with zero.
Decide how routine templates and copied tasks handle estimates before extending
them. Acceptance includes validation, null defaults for old rows/callers, saved
view compatibility, and CSV/JSON round trips. No scoring, automatic scheduling,
time tracking, or effort-based chore balancing is included.

### 8. Backup status

Second backlog recommendation: a small status panel linked to the existing
[recovery procedure](deployment.md#backups-upgrade-and-recovery). Persist the
last success and last failure independently, show configuration/expected cadence,
and distinguish disabled, overdue, and unknown. A failed attempt must not replace
the last success or expose filesystem paths/secrets in the interface. Acceptance
requires restart persistence, permission/full-disk failures, and clear recovery
guidance.

A successful snapshot is not evidence that it is restorable. Say that the usual
separate backup volume is on the same server, and local drafts are excluded.
Only report a verified restore when an isolated restore actually passed. The
[current deployment acceptance record](deployment.md#acceptance-record) still
lists full restore/attachment-restart/cellular checks as outstanding; these are
verification gaps, not proven failures. Avoid a one-click live restore.

### 9. Read-only Today pocket copy

Last, conditional backlog recommendation: explicitly opt in to storing a minimal
snapshot of selected Today titles/checklist text on one device. Show capture
time and expiry, offer explicit refresh/clear, and include no attachments,
history, API token, or offline mutations. Use a bounded lifetime agreed before
implementation; after expiry the app must refuse to display and delete its copy.

This changes the current privacy contract: the service worker presently bypasses
API responses and only capture drafts contain local task content. Local data
remains accessible outside the server session's protection. Local sign-out must
clear the snapshot, but remote logout cannot guarantee immediate deletion on a
disconnected device, and session expiry does not protect already stored data.
Explain those limits before opt-in. Acceptance requires disconnected sign-out,
expiry/restart handling, storage failure, and no hidden background copying.
Do not implement until that privacy tradeoff is accepted.

## Compatibility and delivery rules

- Preserve ordinary API defaults, queue/status semantics, Today persistence,
  checklist independence, and one unfinished recurring occurrence.
- Use app civil dates for new planning/recurrence behavior; preserve legacy
  UTC schedule behavior. Test midnight and timezone transitions where relevant.
- Any server schema change is an appended migration in `src/db.js`; never
  rewrite a shipped migration. Test upgrading populated old databases.
  Add optional fields with safe defaults; retain old local drafts and stable
  in-flight payloads across capture/service-worker updates.
- Keep photo/text processing local and submission explicit. Use synthetic
  examples in public docs and checks; introduce no external service, new login
  system, or third-party processing dependency.
- SQLite snapshots include server attachments. Local drafts do not participate
  in server backups. CSV/JSON exports are useful data extracts, not whole-instance
  restorable backups: current exports omit attachment bytes, comment bodies,
  and chore-specific metadata.
- Each implementation PR must state its bounded scope, recovery behavior, and
  data changes. Run focused API/browser checks and the existing Node 22/24 CI,
  adding behavioral tests for retries, migrations, or recurrence when changed.
  Real-phone/cellular and live restore checks need separate recorded evidence.
- Validate this documentation PR with source reconciliation, relative links and
  anchors, and `git diff --check`. Existing CI runs on pushes and PRs; this prose
  change adds no runtime tests and makes no claim to validate a deployment.

Deferred across the roadmap: AI/OCR task extraction, HEIC conversion libraries,
calendar write-back, complex task dependencies, accounts/permissions/chat,
gamification, autonomous scheduling, full offline editing/conflict sync,
remote backup transport, and release/deployment changes. Reconsider only when
observed use shows a specific need.

## Source map

These are implementation anchors for review, not claims that proposed features
already exist.

| Existing contract | Source |
| --- | --- |
| Capture fields, local save, file rejection, submission resume | [capture.js](../public/capture.js), [draft-store.js](../public/draft-store.js) |
| 1 MB request guard, authenticated ticket/attachment routes | [server.js](../src/server.js), [attachments.js](../src/api/attachments.js) |
| Transactional submission identity and payload matching | [submissions.js](../src/submissions.js), [lost-response tests](../test/planning-http.test.js) |
| Today, Waiting, checklist rules, dashboard/current interface | [planning API](../src/api/planning.js), [planning UI](../public/planning.js), [app.js](../public/app.js), [planning guide](planning.md) |
| Chore load/rotation, recurrence, one unfinished occurrence | [schedules.js](../src/api/schedules.js), [recurrence.js](../src/recurrence.js), [chore tests](../test/chores.test.js) |
| Static-only offline cache boundary | [sw.js](../public/sw.js) |
| Snapshots, data exports, migrations, required CI matrix | [backup.js](../src/backup.js), [export.js](../src/api/export.js), [db.js](../src/db.js), [CI](../.github/workflows/ci.yml) |
