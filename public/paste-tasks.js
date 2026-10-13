export const MAX_BATCH_ROWS = 50;
export const MAX_TITLE_LENGTH = 200;
export const MAX_PASTE_LENGTH = 20000;

/** Keep prose intact; only remove a simple leading list marker and blank lines. */
export function parseTaskList(text) {
  if (typeof text !== 'string' || text.length > MAX_PASTE_LENGTH)
    throw new Error(`Use ${MAX_PASTE_LENGTH.toLocaleString('en-US')} characters or fewer per list.`);
  const titles = text.split(/\r\n?|\n/).map((line) =>
    line.trimStart().replace(/^(?:[-*+•]|\d+[.)])(?:\s+|$)/u, '').trim(),
  ).filter(Boolean);
  if (!titles.length) throw new Error('Paste at least one task, one per line.');
  if (titles.length > MAX_BATCH_ROWS)
    throw new Error(`This list has ${titles.length} tasks. Reduce it to ${MAX_BATCH_ROWS} or fewer; nothing was removed.`);
  return titles;
}

export function titleError(title) {
  if (typeof title !== 'string' || !title.trim()) return 'Give this task a title.';
  if (title.trim().length > MAX_TITLE_LENGTH)
    return `Use ${MAX_TITLE_LENGTH} characters or fewer (${title.trim().length} now).`;
  return '';
}

export function newBatch(id = crypto.randomUUID()) {
  return {
    id, kind: 'paste-tasks', version: 1, revision: 0, stage: 'input', source: '', rows: [],
    updated_at: new Date().toISOString(),
  };
}

export function previewRows(source) {
  return parseTaskList(source).map((title) => ({
    id: crypto.randomUUID(), title, included: true, payload: null,
    ticket_id: null, error: '',
  }));
}

export function batchCounts(batch) {
  const selected = batch.rows.filter((row) => row.included || row.payload);
  return {
    selected: selected.length,
    saved: selected.filter((row) => row.ticket_id).length,
    pending: selected.filter((row) => !row.ticket_id).length,
  };
}

const submitting = new Set();

/** Persist identity and immutable content before sending; stop at the first failure. */
export async function submitBatch(batch, { persist, create, changed = () => {} }) {
  if (submitting.has(batch.id)) throw new Error('This list is already saving.');
  if (batch.kind !== 'paste-tasks' || batch.version !== 1 ||
      batch.stage !== 'preview' || !Array.isArray(batch.rows) ||
      batch.rows.length > MAX_BATCH_ROWS)
    throw new Error('Reopen the list preview before saving.');
  const ids = new Set();
  for (const row of batch.rows) {
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(row.id) || ids.has(row.id))
      throw new Error('This list has an invalid task identity. Keep it open and start a new list.');
    ids.add(row.id);
    if (row.included && !row.payload && titleError(row.title))
      throw new Error('Edit or exclude the highlighted tasks before saving.');
  }
  if (!batchCounts(batch).selected) throw new Error('Include at least one task.');
  submitting.add(batch.id);
  try {
    for (const row of batch.rows) {
      if (row.ticket_id || (!row.included && !row.payload)) continue;
      try {
        if (!row.payload) row.payload = { title: row.title.trim(), queue: 'inbox' };
        row.error = '';
        // Includes earlier confirmations, and must commit before any network write.
        await persist(batch);
        changed();
        const ticket = await create(row.id, row.payload);
        if (!Number.isSafeInteger(ticket?.id) || ticket.id < 1)
          throw new Error('The response could not be confirmed. Resume to check this task safely.');
        row.ticket_id = ticket.id;
        await persist(batch);
        changed();
      } catch (error) {
        row.error = error.message || 'Connection lost. Resume to check this task safely.';
        // Even a rejected request keeps its payload: never guess an uncertain outcome.
        await persist(batch).catch(() => {});
        changed();
        throw error;
      }
    }
    return batchCounts(batch);
  } finally {
    submitting.delete(batch.id);
  }
}
