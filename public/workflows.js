import { randomId } from './uuid.js';
import { invalidateNavigationReads, offlineState } from './offline.js';

// These deliberate planning workflows always read current server state.
export async function online(path, { method = 'GET', body, key } = {}) {
  const res = await fetch('/api' + path, {
    method, cache: 'no-store', signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  if (method !== 'GET') invalidateNavigationReads();
  return data;
}

export function reviewGroups(tasks, today) {
  const date = new Date(today + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + 7);
  const week = date.toISOString().slice(0, 10);
  const active = tasks.filter(t => t.is_open);
  return [
    { title: 'Dates & follow-ups', text: 'Deadlines include every list. Snoozed follow-ups stay hidden until they return.', tasks: active.filter(t => t.due_date && t.due_date <= week || t.waiting_on && t.follow_up_date && t.follow_up_date <= today && !(t.snoozed_until > today)) },
    { title: 'Older tasks', text: 'Up to 20 older Inbox and actionable Next tasks. You can leave any item unchanged.', tasks: active.filter(t => ['inbox', 'next'].includes(t.queue) && t.today_rank === null && !t.waiting_on && !(t.snoozed_until > today)).slice(0, 20) },
    { title: 'Your Today list', text: 'These selections stay until you finish or remove them. Nothing resets at midnight.', tasks: active.filter(t => t.today_rank !== null).sort((a,b) => a.today_rank - b.today_rank || a.id - b.id) },
  ];
}

export async function renderReview(view, query, ui) {
  const { el, guard } = ui;
  const [planning, tasks] = await Promise.all([online('/planning'), online('/tickets?status=active&sort=oldest')]);
  const groups = reviewGroups(tasks, planning.today);
  const step = Math.max(0, Math.min(2, Math.trunc(Number(query.step) || 0)));
  const group = groups[step];
  view.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Review Today'), el('p', {}, `Step ${step + 1} of 3 · ${group.title}`)), el('a', { class: 'btn', href: '#/today' }, 'Finish review')),
    el('p', {}, group.text), el('p', { class: 'muted' }, 'Opening or leaving this review changes nothing. Each action saves immediately.'));
  for (const task of group.tasks) {
    const controls = el('fieldset', { class: 'planning-actions' });
    const action = (title, body) => el('button', { type: 'button', class: 'btn btn-sm', onclick: guard(async () => {
      if (body.today && (task.waiting_on || task.snoozed_until > planning.today) && !confirm('Add to Today moves this task to Next and clears its waiting and snooze settings. Continue?')) return;
      controls.disabled = true;
      try { await online(`/tickets/${task.id}`, { method: 'PATCH', body }); await ui.render(); }
      finally { controls.disabled = false; }
    }) }, title);
    const date = el('input', { type: 'date', 'aria-label': `Snooze ${task.title} until` });
    controls.append(action(task.today_rank === null ? 'Add to Today' : 'Remove from Today', { today: task.today_rank === null }), action('Next', { queue: 'next' }), action('Someday', { queue: 'someday' }), date,
      el('button', { type: 'button', class: 'btn btn-sm', onclick: guard(async () => {
        if (!date.value || date.value <= planning.today) throw new Error('Choose a future snooze date.');
        controls.disabled = true;
        try { await online(`/tickets/${task.id}`, { method: 'PATCH', body: { snoozed_until: date.value } }); await ui.render(); }
        finally { controls.disabled = false; }
      }) }, 'Snooze'));
    view.append(el('section', { class: 'card review-task' }, el('h2', {}, el('a', { href: `#/tickets/${task.id}` }, task.title)),
      el('p', { class: 'muted' }, [task.due_date && `Deadline: ${task.due_date}`, task.waiting_on && `Waiting: ${task.waiting_on}`, task.follow_up_date && `Follow up: ${task.follow_up_date}`].filter(Boolean).join(' · ')), controls));
  }
  if (!group.tasks.length) view.append(el('p', { class: 'empty-state' }, 'Nothing to review in this step.'));
  view.append(el('div', { class: 'planning-actions' }, step > 0 && el('a', { class: 'btn', href: `#/review?step=${step-1}` }, 'Previous step'),
    step < 2 ? el('a', { class: 'btn btn-primary', href: `#/review?step=${step+1}` }, 'Next step') : el('a', { class: 'btn btn-primary', href: '#/do-now' }, 'Do now')));
}

// Keep an uncertain operation's identity and text until its receipt is recovered.
export async function renderFocus(view, query, ui) {
  const { el, guard } = ui;
  const tasks = await online('/tickets?today=true&sort=today');
  const id = query.task ? Number(query.task) : tasks[0]?.id;
  view.append(el('div', { class: 'page-head' }, el('h1', {}, 'Do now'), el('a', { class: 'btn', href: '#/today' }, 'Back to Today')));
  if (!id || !tasks.some(t => t.id === id)) {
    view.append(el('p', { class: 'empty-state' }, id ? 'This task is no longer in Today. Your list may have changed on another device.' : 'Your Today list is empty.'), el('a', { class: 'btn', href: '#/do-now' }, 'Refresh Today tasks'));
    return;
  }
  const task = await online(`/tickets/${id}`);
  if (!task.is_open || task.today_rank === null) { view.append(el('p', {}, 'This task changed. Return to Today to choose another.')); return; }
  const draft = (await offlineState()).focusDrafts?.[id] || { text: '', pending: null };
  let saving = Promise.resolve();
  const persist = () => {
    const copy = structuredClone(draft);
    saving = saving.catch(() => {}).then(() => offlineState(s => { s.focusDrafts ||= {}; s.focusDrafts[id] = copy; }));
    return saving;
  };
  const controls = el('fieldset', { class: 'focus-controls' });
  const status = el('p', { role: 'status' });
  const retry = el('button', { type: 'button', class: 'btn', hidden: !draft.pending, onclick: guard(async () => {
    if (draft.pending) await mutate(draft.pending.kind, draft.pending.changes);
  }) }, 'Retry unfinished action');
  const mutate = async (kind, changes) => {
    if (draft.pending && JSON.stringify([draft.pending.kind, draft.pending.changes]) !== JSON.stringify([kind, changes])) {
      status.textContent = 'Retry the unfinished action before making another change.';
      return;
    }
    draft.pending ||= { id: randomId(), ticket_id: id, revision: task.revision, kind, changes };
    controls.disabled = true;
    try {
      await persist();
      const result = await online('/sync/operations', { method: 'POST', body: draft.pending });
      if (result.state !== 'applied') {
        draft.pending = null;
        await persist();
        throw new Error('This task changed on another device. Your note is retained; refresh before trying again.');
      }
      draft.pending = null;
      if (kind === 'note') draft.text = '';
      await persist();
      if (kind === 'edit' && changes.status === 'resolved') {
        location.hash = next ? `#/do-now?task=${next.id}` : '#/today';
        return;
      }
      await ui.render();
    } catch (error) { status.textContent = error.message + (draft.pending ? ' Retry the same action to recover its result.' : ''); }
    finally { controls.disabled = false; retry.hidden = !draft.pending; }
  };
  controls.append(el('h2', {}, task.title), task.body && el('p', { class: 'preserve-lines' }, task.body));
  for (const item of task.checklist) controls.append(el('label', { class: 'focus-check' }, el('input', { type: 'checkbox', checked: Boolean(item.completed), onchange: async event => {
    const wanted = event.target.checked;
    event.target.checked = Boolean(item.completed);
    await mutate('check', { item_id: item.id, completed: wanted });
  } }), item.title));
  controls.append(el('h3', {}, 'Notes'), ...task.comments.map(note => el('p', { class: 'preserve-lines' }, note.body)));
  const note = el('textarea', { name: 'focus-note', 'aria-label': 'New note', maxlength: 20000, readonly: Boolean(draft.pending?.kind === 'note'), oninput: event => { draft.text = event.target.value; persist().catch(error => { status.textContent = 'Could not save your note on this device: ' + error.message; }); } }, draft.text);
  const form = el('form', { onsubmit: guard(async event => { event.preventDefault(); if (!draft.text.trim()) return; await mutate('note', { body: draft.text }); note.readOnly = Boolean(draft.pending?.kind === 'note'); }) }, note, el('button', { class: 'btn', type: 'submit' }, 'Save note'));
  controls.append(form, retry);
  const next = tasks[tasks.findIndex(t => t.id === id) + 1];
  controls.append(el('div', { class: 'planning-actions' },
    el('button', { class: 'btn btn-primary', onclick: guard(async () => { if (draft.text || draft.pending?.kind === 'note') throw new Error('Save your note before finishing the task.'); await mutate('edit', { status: 'resolved' }); }) }, 'Done'),
    el('a', { class: 'btn', href: next ? `#/do-now?task=${next.id}` : '#/today' }, next ? 'Next task' : 'Back to Today'),
    el('button', { class: 'btn', onclick: () => ui.render() }, 'Refresh')));
  view.append(el('section', { class: 'card focus-session' }, controls, status));
}
