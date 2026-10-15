# iPhone-first Task Hub

Task Hub opens on Dashboard. Its mobile layout follows the warm concept A:
ivory surfaces, terracotta accents, serif headings, bottom navigation, and
full-screen editing. Dark mode follows the device preference. More contains
the other tools, **App & notifications**, and **Offline & sync**.

## Install on iPhone

1. Connect to Tailscale when needed and open your private HTTPS Task Hub address
   in Safari. Sign in.
2. Open Share, choose **Add to Home Screen**, and enable **Open as Web App** if
   offered. Open the new Task Hub icon.
3. Visit **More → App & notifications** for installation and notification help.

Installation, notification permission, and a real notification arriving on your
iPhone still require device verification. The desktop browser tests do not
establish those results. No App Store download or public exposure is required.

Updates show an **Update now** notice. Save or close forms first. Updating does
not clear IndexedDB drafts or pending edits. The service worker caches the
static application shell, never API responses. `/app-shell.html` is an anonymous
alias for that data-free shell; API authentication remains mandatory.

## Offline behavior

After sign-in, the app saves active tasks, descriptions, notes, and checklists
on this device. Home, Today, Inbox, and Tasks work with that snapshot offline.
Search covers cached tasks only. Completed history, attachment downloads,
project/routine administration, and chore assignments need a connection.
Offline dashboard device statistics are from the last snapshot.

Supported offline writes are title/description edits, new notes, task completion,
and toggling existing checklist steps. Changes are written to IndexedDB before
the UI reports success. They synchronize when Task Hub opens, returns to the
foreground, reconnects, or you press Retry sync. They do not require background
execution while the app is closed.

New capture forms autosave as drafts. Press **Save to Inbox** to queue a draft
for submission, then return to Task Hub; queued captures submit on reconnection.
An unfinished draft is never submitted just because the connection returns.
The active capture screen retains ownership of its draft until you leave it.
Queued captures freeze their fields and files; use Resume submission to retry
from the capture screen. The existing idempotency keys prevent duplicate tasks
and attachments after a lost response. Photos the browser can decode are resized
to the existing 1 MB limit; unsupported HEIC/HEIF files request a compatible image.

**Offline & sync** shows last-sync time, pending edits, errors, export, and
conflicts. A newer server revision pauses that task's changes. Compare versions
and choose **Apply my changes** or **Use server / discard local task changes**.
Other tasks can continue syncing. Deleted tasks can be recovered as drafts.
Invalid operations can be exported or recovered before discarding.

Session expiry pauses synchronization and retains pending work for sign-in.
Explicit sign-out clears cached server tasks and warns before discarding unsent
edits; drafts have a separate keep/clear choice. A browser may remove device
storage, so unsent work is not a server backup. Export valuable unsent changes
before clearing browser data or moving devices.

## Configure push delivery

The server uses the `web-push` runtime package and its locked dependencies.
Run `npm ci --ignore-scripts` before starting or testing a checkout. Docker
installs production dependencies from the lockfile.

Generate VAPID keys once on the deployment host:

```sh
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

Save the values securely in the existing `.env`:

```dotenv
WEB_PUSH_PUBLIC_KEY=<publicKey>
WEB_PUSH_PRIVATE_KEY=<privateKey>
WEB_PUSH_SUBJECT=mailto:your-contact@example.com
```

All three values are required together. Do not commit the private key. Preserve
the keys across upgrades; changing them requires re-enrolling devices. Compose
passes these settings to the container. The server needs outbound HTTPS access
to the browser push service; Task Hub itself stays private. Supported endpoints
are Apple, Google FCM, Mozilla, and Windows notification services.

After deploying the configured server, open the installed app and press
**Enable notifications**. Permission is requested only from that action. A
denial leaves the app usable and shows guidance for changing system permissions.
Use **Send test** to verify delivery and **Disable on this device** to unsubscribe.

Each device has separate preferences. Defaults after enrollment:

- Daily summary enabled at 09:00 in `APP_TIME_ZONE` (normally America/Denver).
- Individual reminders disabled; enable due-today, overdue, and/or follow-up
  categories as desired.
- No empty daily summary. Individual reminders fire once per deadline or
  follow-up date, rather than repeating every day a task is overdue.

A separate minute timer checks push delivery, even if the legacy maintenance
timer is disabled. Persistent receipts prevent repeated successful sends across
restarts. Failed deliveries retry up to five times with backoff; expired
subscriptions are removed. Task completion and changed preferences suppress
ineligible retries. Delivery is best effort: a provider accepting a notification
does not prove the phone displayed it, and an ambiguous provider timeout can
still result in repeat delivery. Stable notification tags replace matching alerts.

The badge counts unique unfinished tasks in Today, due/overdue tasks, and due
follow-ups. It refreshes in the foreground or with visible notifications, not
through silent background pushes. Individual alerts open their task; summaries
open Dashboard. Task content requires private-server connectivity or cached data.
Existing webhook notifications remain independent.

## API and persistence

All new APIs require the existing authentication. Existing callers continue
working without sending revision fields.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/sync/snapshot` | Consistent snapshot of active tasks, planning metadata, saved views, dashboard statistics, and sync time |
| `POST /api/sync/operations` | `{id, ticket_id, revision, kind, changes}`; kinds `edit`, `note`, `check`; returns `applied`, `conflict` with current task, or `deleted` |
| `GET /api/push/config` | Availability and public VAPID key only |
| `POST /api/push/subscriptions` | Register `{subscription, settings}` and return a device UUID |
| `GET/PATCH/DELETE /api/push/subscriptions/:id` | Read/update preferences or unsubscribe |
| `POST /api/push/subscriptions/:id/test` | Request a visible test notification |

Edit changes allow `title`, `body`, and `status: resolved`; note changes contain
`body`; checklist changes contain `item_id` and boolean `completed`. An operation
ID must remain identical, including its payload, on retry. After an acknowledged
operation, its successor uses the returned revision. Conflict resolution creates
a new operation ID against the reviewed server revision.

The additive migration introduces task revisions, operation receipts, push
subscriptions, and delivery receipts. Revisions also advance for existing update
paths. No existing migration is edited. Receipts and subscriptions are included
in SQLite backups; unsent device edits and VAPID environment secrets are not.

## Validation and rollout

Run `npm ci --ignore-scripts`, `npm test`, and `git diff --check`. The test suite
covers revision conflicts, lost-response retries, recurrence, API authentication,
subscription UUID routing, scheduling/DST, delivery retry bounds, and revocation.

Local browser validation used Playwright with Edge and Windows WebKit. Edge
passed offline edit/reload/reconnect, visible conflict resolution, notes,
checklists, automatic capture submission, lost-response deduplication, storage
failure preservation, and an upgrade from the previous service worker with an
open editor. Mobile route checks and widths 375/390/430 plus desktop 1280 showed
no horizontal overflow. Light and dark screenshots were inspected.

Windows WebKit passed the interaction checks, but its emulated offline page
reload produced an internal navigation error; it also emitted an access-control
error during network transitions. Those results do not prove iPhone offline
relaunch reliability. Physical-iPhone installation, safe areas/keyboard, photo
selection, VoiceOver, suspension/relaunch, private cellular access, and actual push
delivery remain manual acceptance checks. Docker build and hosted CI are separate
from these local checks.

For production, use the existing deployment procedure: verify a pre-migration
database backup and retain the previous image and environment. Test the new image
against a copy before changing the active service. On rollback, restore the
pre-migration database with its matching image; reconcile any later server writes
before doing so. This implementation does not deploy or alter the live instance.
