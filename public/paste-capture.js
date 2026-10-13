import { getDraft, putBatchDraft, deleteDraft } from './draft-store.js';
import {
  newBatch, previewRows, titleError, batchCounts, submitBatch, MAX_BATCH_ROWS,
} from './paste-tasks.js';

export async function renderPasteCapture(view, query, ui, { setPending, response }) {
  const { el, field, guard } = ui;
  view.classList.add('capture-page');
  let draft = query.draft ? await getDraft(query.draft) : newBatch();
  if (!draft || draft.kind !== 'paste-tasks' || draft.version !== 1) {
    view.append(
      el('h1', {}, 'List draft unavailable'),
      el('p', {}, 'Return to Drafts to reopen your saved capture.'),
      el('a', { href: '#/drafts', class: 'btn' }, 'View drafts'),
    );
    return;
  }
  if (!query.draft) {
    draft.revision = await putBatchDraft(draft, { create: true });
    history.replaceState(null, '', `${location.pathname}${location.search}#/paste?draft=${draft.id}`);
  }
  let busy = false, saving = Promise.resolve();
  const status = el('p', { class: 'capture-status', role: 'status' }, 'Saved on this device');
  const tell = (text, error = false) => {
    status.textContent = text;
    status.classList.toggle('error', error);
  };
  const persist = () => {
    draft.updated_at = new Date().toISOString();
    const snapshot = structuredClone(draft);
    saving = saving.catch(() => {}).then(async () => {
      // Queued edits use the revision from the preceding committed write.
      snapshot.revision = draft.revision ?? 0;
      draft.revision = await putBatchDraft(snapshot);
    }).catch((error) => {
      if (error.name === 'DraftConflictError') throw error;
      throw new Error('Could not save on this device. Keep this page open and free some storage before continuing.');
    });
    return saving;
  };
  const saveEdit = () => persist().then(
    () => tell(navigator.onLine ? 'Saved on this device' : 'Offline · saved on this device'),
    (error) => tell(error.message, true),
  );
  const source = el('textarea', {
    name: 'task-list', placeholder: 'Buy groceries\n• Call the dentist\n3. Replace the filter',
    rows: 8,
    oninput: () => { draft.source = source.value; saveEdit(); },
  }, draft.source);
  const inputPanel = el('section', { class: 'card planning-card' },
    field('List', source),
    el('p', { class: 'muted' }, `One task per nonempty line. Simple bullets and numbers are removed. Preview up to ${MAX_BATCH_ROWS} tasks; titles can be edited before saving.`),
  );
  const rows = el('ol', { class: 'paste-rows' });
  const summary = el('p', { class: 'paste-summary', role: 'status' });
  const previewPanel = el('section', { class: 'paste-preview' },
    el('h2', {}, 'Review tasks'), summary,
    el('p', { class: 'muted' }, 'Destination: Inbox. Edit, remove, or exclude tasks before saving. No dates or other details are inferred.'),
    rows,
  );
  const primary = el('button', { type: 'submit', class: 'btn btn-primary' });
  const editSource = el('button', {
    type: 'button', class: 'btn', onclick: guard(async () => {
      if (busy || draft.rows.some((row) => row.payload)) return;
      draft.stage = 'input';
      draw();
      await persist();
      source.focus();
    }),
  }, 'Edit pasted list');
  const signIn = el('a', {
    href: '/login', class: 'btn', hidden: true,
    onclick: () => sessionStorage.setItem('taskhub-return', `/capture.html#/paste?draft=${draft.id}`),
  }, 'Sign in');
  const discard = el('button', {
    type: 'button', class: 'btn btn-sm', onclick: guard(async () => {
      if (busy) return;
      if (draft.rows.some((row) => row.payload) &&
          !confirm('Discard this local list and its remaining rows? Any tasks already saved, including an unconfirmed response, stay in Inbox.')) return;
      await saving.catch(() => {});
      await deleteDraft(draft.id);
      location.hash = '#/drafts';
    }),
  });
  let controls = [];
  const refresh = () => {
    const preview = draft.stage === 'preview';
    const counts = batchCounts(draft);
    const started = draft.rows.some((row) => row.payload);
    inputPanel.hidden = preview;
    previewPanel.hidden = !preview;
    source.disabled = busy;
    editSource.hidden = !preview || started;
    editSource.disabled = busy;
    primary.disabled = busy || (preview && !counts.pending);
    primary.textContent = busy ? 'Saving…' : !preview ? 'Preview tasks' : started ? 'Resume remaining tasks' : `Save ${counts.pending} to Inbox`;
    summary.textContent = `${counts.selected} selected · ${counts.saved} saved · ${counts.pending} pending`;
    discard.disabled = busy;
    discard.textContent = !started ? 'Cancel preview' : counts.pending ? 'Discard remainder' : 'Clear local list';
    for (const { row, input, include, remove, note } of controls) {
      const locked = Boolean(row.payload);
      input.disabled = busy || locked;
      include.disabled = busy || locked;
      remove.disabled = busy || locked;
      const invalid = !locked && row.included ? titleError(row.title) : '';
      input.setAttribute('aria-invalid', Boolean(invalid));
      note.classList.toggle('error', Boolean(invalid || row.error));
      note.replaceChildren(row.ticket_id
        ? el('a', { href: `/#/tickets/${row.ticket_id}` }, 'Saved to Inbox')
        : invalid || (locked
          ? `Needs retry · ${row.error || 'Outcome unconfirmed. Resume to check safely.'}`
          : row.included ? 'Pending' : 'Excluded'));
    }
  };
  const draw = () => {
    controls = [];
    rows.replaceChildren(...draft.rows.map((row, index) => {
      const note = el('p', { class: 'draft-meta', id: `paste-status-${row.id}` });
      const input = el('input', {
        value: row.payload?.title ?? row.title, 'aria-label': `Task ${index + 1}`,
        'aria-describedby': note.id,
        oninput: () => { row.title = input.value; row.error = ''; refresh(); saveEdit(); },
      });
      const include = el('input', {
        type: 'checkbox', checked: row.included || Boolean(row.payload),
        'aria-label': `Include task ${index + 1}`,
        onchange: () => { row.included = include.checked; refresh(); saveEdit(); },
      });
      const remove = el('button', {
        type: 'button', class: 'btn btn-sm', 'aria-label': `Remove task ${index + 1}`,
        onclick: () => {
          if (busy || row.payload) return;
          draft.rows = draft.rows.filter((item) => item.id !== row.id);
          draw();
          saveEdit();
        },
      }, 'Remove');
      controls.push({ row, input, include, remove, note });
      return el('li', { class: 'paste-row' },
        el('div', { class: 'paste-row-controls' }, include,
          el('label', { class: 'paste-row-title' }, `Task ${index + 1}`, input), remove),
        note,
      );
    }));
    refresh();
  };
  const form = el('form', { class: 'paste-capture', novalidate: true, onsubmit: guard(async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    setPending(location.hash);
    refresh();
    try {
      await saving.catch(() => {});
      // A prior storage failure must be retryable after space is freed, without reloading.
      await persist();
      if (draft.stage === 'input') {
        draft.rows = previewRows(draft.source);
        draft.stage = 'preview';
        draw();
        await persist();
        tell('Preview saved on this device. Nothing has been submitted.');
      } else {
        if (!navigator.onLine) throw new Error('Offline. Your list is saved; resume when connected.');
        tell('Saving tasks to Inbox…');
        const result = await submitBatch(draft, {
          persist, changed: refresh,
          create: (key, payload) => fetch('/api/tickets', {
            method: 'POST', signal: AbortSignal.timeout(15000),
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
            body: JSON.stringify(payload),
          }).then(response),
        });
        tell(`${result.saved} ${result.saved === 1 ? 'task' : 'tasks'} saved to Inbox.`);
      }
    } catch (error) {
      if (error.status === 401) signIn.hidden = false;
      tell(error.message || 'Connection lost. Resume to check your tasks safely.', true);
    } finally {
      busy = false;
      setPending(null);
      refresh();
    }
  }) }, inputPanel, previewPanel, status,
    el('div', { class: 'planning-actions capture-footer' }, primary, editSource,
      el('a', { class: 'btn', href: '/#/inbox' }, 'View Inbox'),
      el('a', { class: 'btn', href: '#/drafts' }, 'View drafts'), signIn, discard),
  );
  view.append(
    el('h1', {}, 'Paste as tasks'),
    el('p', { class: 'draft-notice' }, 'This list is saved on this device. Tasks are created only when you choose Save to Inbox. Canceling keeps any tasks already saved.'),
    form,
  );
  draw();
  fetch('/api/auth/session').then((res) => { signIn.hidden = res.ok; }).catch(() => {});
}
