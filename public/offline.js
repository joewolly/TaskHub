import { matchesTime } from './time-estimates.js';
import { randomId } from './uuid.js';
import { createReadCache } from './read-cache.js';

const navigationReads = createReadCache();
export function invalidateNavigationReads() { navigationReads.clear(); }

// One atomic IndexedDB record keeps snapshots and the durable outbox consistent.
let connection;
let lastError = '';
let disconnected = !navigator.onLine;
let syncing;
const empty = () => ({ tasks: [], operations: [], snapshot: null, locked: false, focusDrafts: {} });
function database() {
  return connection ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('taskhub-offline', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { connection = null; reject(new Error('Device storage is unavailable. Changes have not been saved.')); };
  });
}
export async function offlineState(change) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', change ? 'readwrite' : 'readonly');
    const store = tx.objectStore('state'); const request = store.get('current'); let state;
    request.onsuccess = () => {
      state = request.result || empty();
      try { if (change) { change(state); store.put(state, 'current'); } }
      catch (error) { tx.abort(); reject(error); }
    };
    tx.oncomplete = () => resolve(state);
    tx.onabort = tx.onerror = () => reject(new Error('Could not save on this device. Free storage and try again; your change is not saved.'));
  });
}
function overlay(state) {
  const tasks = structuredClone(state.tasks);
  for (const op of state.operations) {
    const task = tasks.find(t => t.id === op.ticket_id); if (!task) continue;
    if (op.kind === 'edit') {
      Object.assign(task, op.changes);
      if (op.changes.status === 'resolved') { task.is_open = false; task.today_rank = null; }
    }
    if (op.kind === 'note') task.comments.push({ id: op.id, body: op.changes.body, created_at: op.created_at });
    if (op.kind === 'check') {
      const item = task.checklist.find(i => i.id === op.changes.item_id);
      if (item) item.completed = Number(op.changes.completed);
      task.checklist_completed = task.checklist.filter(i => i.completed).length;
    }
    task.pending = true;
  }
  return tasks;
}
function filtered(tasks, query, today) {
  let rows = tasks.filter(t => query.get('status') === 'all' || (query.get('status') === 'done' ? !t.is_open : query.get('status') && query.get('status') !== 'active' ? t.status === query.get('status') : t.is_open));
  for (const key of ['queue', 'priority', 'project_id', 'device_id']) if (query.get(key)) rows = rows.filter(t => String(t[key]) === query.get(key));
  if (query.get('tag')) rows = rows.filter(t => t.tags.includes(query.get('tag')));
  if (query.get('today') === 'true') rows = rows.filter(t => t.today_rank !== null);
  if (query.get('waiting') === 'true') rows = rows.filter(t => t.waiting_on);
  if (query.get('snoozed') === 'true') rows = rows.filter(t => t.snoozed_until > today);
  if (query.get('actionable') === 'true') rows = rows.filter(t => (!t.snoozed_until || t.snoozed_until <= today) && (!t.waiting_on || t.follow_up_date && t.follow_up_date <= today));
  if (query.get('q')) { const text = query.get('q').toLowerCase(); rows = rows.filter(t => [t.title, t.body, ...t.comments.map(c => c.body)].join(' ').toLowerCase().includes(text)); }
  const due = query.get('due');
  if (due) rows = rows.filter(t => due === 'none' ? !t.due_date : due === 'overdue' ? t.due_date && t.due_date < today : due === 'today' ? t.due_date === today : t.due_date && t.due_date >= today && t.due_date <= new Date(new Date(today + 'T12:00Z').getTime() + 7 * 86400000).toISOString().slice(0, 10));
  const priority = { critical: 0, high: 1, medium: 2, low: 3 }, sort = query.get('sort');
  rows.sort((a, b) => sort === 'today' ? a.today_rank - b.today_rank || a.id - b.id : sort === 'oldest' ? a.id - b.id : sort === 'newest' ? b.id - a.id : sort === 'updated' ? b.updated_at.localeCompare(a.updated_at) : sort === 'due' ? (a.due_date || '9999').localeCompare(b.due_date || '9999') : priority[a.priority] - priority[b.priority] || b.id - a.id);
  return rows.filter(task => matchesTime(task, Object.fromEntries(query)));
}
async function cached(path) {
  const state = await offlineState();
  if (state.locked || !state.snapshot) throw new Error('Connect and sign in to make active tasks available offline.');
  const url = new URL(path, location.origin), tasks = overlay(state);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: state.snapshot.planning.time_zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (url.pathname === '/planning') return { ...state.snapshot.planning, today };
  if (url.pathname === '/views') return state.snapshot.views;
  if (url.pathname === '/tickets') {
    if (url.searchParams.get('status') === 'done') throw new Error('Completed history requires a connection.');
    return filtered(tasks, url.searchParams, today);
  }
  const detail = url.pathname.match(/^\/tickets\/(\d+)(\/checklist)?$/);
  if (detail) {
    const task = tasks.find(t => t.id === Number(detail[1]));
    if (!task) throw new Error('This task is not saved on this device. Connect to load it.');
    return detail[2] ? task.checklist : task;
  }
  if (url.pathname === '/tags') return [...new Set(tasks.flatMap(t => t.tags))].map(name => ({ name, ticket_count: tasks.filter(t => t.tags.includes(name)).length }));
  if (url.pathname === '/stats') return { ...state.snapshot.stats,
    overdue: tasks.filter(t => t.is_open && t.due_date && t.due_date < today),
    follow_ups: tasks.filter(t => t.is_open && t.waiting_on && t.follow_up_date && t.follow_up_date <= today),
    stale: tasks.filter(t => t.is_open && t.queue === 'next' && !t.waiting_on && (!t.snoozed_until || t.snoozed_until <= today) && new Date(today) - new Date(t.updated_at) > 14 * 86400000),
  };
  throw new Error('This screen needs a connection. Active tasks and checklists remain available in Home, Today, Inbox, and Tasks.');
}
async function request(path, options = {}) {
  const method = options.method || 'GET';
  if (method !== 'GET') {
    navigationReads.clear();
    try { return await fetchRequest(path, options); }
    finally { navigationReads.clear(); }
  }
  if (/^\/(planning|views|devices|tags|stats|tickets)(\?|$)/.test(path)) {
    return navigationReads.get(path, () => fetchRequest(path, options));
  }
  return fetchRequest(path, options);
}
async function fetchRequest(path, options) {
  let response;
  try { response = await fetch('/api' + path, { ...options, signal: AbortSignal.timeout(12000) }); }
  catch { disconnected = true; throw new Error('Task Hub is unreachable. Your saved changes will retry when connected.'); }
  disconnected = false;
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    if (response.status === 401) navigationReads.clear();
    const error = new Error(body?.error || `HTTP ${response.status}`); error.status = response.status; throw error;
  }
  return body;
}
function operation(path, method, body, task) {
  const detail = path.match(/^\/tickets\/(\d+)$/), note = path.match(/^\/tickets\/(\d+)\/comments$/), check = path.match(/^\/tickets\/(\d+)\/checklist\/(\d+)$/);
  let kind, changes;
  if (detail && method === 'PATCH') {
    changes = { ...body };
    // The shared editor submits unchanged tags alongside title and description.
    if ('tags' in changes && JSON.stringify([...changes.tags].sort()) === JSON.stringify([...task.tags].sort())) delete changes.tags;
    if (Object.keys(changes).some(k => !['title', 'body', 'status'].includes(k)) || 'status' in changes && changes.status !== 'resolved') return null;
    kind = 'edit';
  } else if (note && method === 'POST') { kind = 'note'; changes = body; }
  else if (check && method === 'PATCH' && Object.keys(body).every(k => k === 'completed')) { kind = 'check'; changes = { item_id: Number(check[2]), completed: !!body.completed }; }
  else return null;
  if ('title' in changes && (typeof changes.title !== 'string' || !changes.title.trim() || changes.title.trim().length > 200)) throw new Error('Use a task title between 1 and 200 characters.');
  if ('body' in changes && (typeof changes.body !== 'string' || changes.body.length > 20000 || kind === 'note' && !changes.body.trim())) throw new Error('Notes must contain text and be no longer than 20,000 characters.');
  return { id: randomId(), ticket_id: task.id, revision: task.revision, kind, changes, created_at: new Date().toISOString() };
}
export async function offlineApi(path, { method = 'GET', body } = {}) {
  const id = Number(path.match(/^\/tickets\/(\d+)/)?.[1]);
  const state = await offlineState().catch(error => { lastError = error.message; return empty(); });
  if (method !== 'GET' && !state.locked && id) {
    const task = overlay(state).find(t => t.id === id);
    const op = task && operation(path, method, body, task);
    if (op) {
      navigationReads.clear();
      await offlineState(s => { s.operations.push(op); });
      await updateStatus();
      void syncNow();
      return cached(`/tickets/${id}`);
    }
  }
  // Pending edits must remain visible even while a refresh is in flight.
  if (method === 'GET' && state.operations.length && ['/tickets', '/stats'].some(p => path.startsWith(p))) return cached(path);
  if (!navigator.onLine || disconnected) {
    disconnected = true;
    if (method === 'GET') return cached(path);
    throw new Error('This change needs a connection. Offline you can edit titles/descriptions, add notes, complete tasks, and check steps.');
  }
  try {
    const result = await request(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (method !== 'GET' && /^\/(tickets|projects|schedules)/.test(path)) void syncNow();
    return result;
  } catch (error) {
    if (error.status === 401) {
      await offlineState(s => { s.locked = true; });
      sessionStorage.setItem('taskhub-return', location.pathname + location.hash);
      location.replace('/login');
    }
    if (method === 'GET' && disconnected) { await updateStatus(); return cached(path); }
    throw error;
  }
}
export function syncNow() {
  if (syncing) return syncing;
  const run = async () => {
    window.taskhubSyncBusy = true;
    try {
      if (!navigator.onLine) { disconnected = true; return; }
      await request('/auth/session');
      await offlineState(s => { s.locked = false; });
      await submitDrafts();
      const blocked = new Set();
      for (const original of (await offlineState()).operations) {
        const op = (await offlineState()).operations.find(o => o.id === original.id);
        if (!op || op.problem || blocked.has(op.ticket_id)) { if (op) blocked.add(op.ticket_id); continue; }
        let result;
        try { result = await request('/sync/operations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) }); }
        catch (error) {
          if (error.status !== 400) throw error;
          await offlineState(s => { const current = s.operations.find(o => o.id === op.id); if (current) current.problem = { state: 'invalid', error: error.message }; });
          blocked.add(op.ticket_id); continue;
        }
        await offlineState(s => {
          const current = s.operations.find(o => o.id === op.id); if (!current) return;
          if (result.state !== 'applied') { current.problem = result; blocked.add(op.ticket_id); return; }
          s.operations = s.operations.filter(o => o.id !== op.id);
          s.tasks = s.tasks.filter(t => t.id !== op.ticket_id).concat(result.task);
          // Only successors of this acknowledged operation may inherit its revision.
          const next = s.operations.find(o => o.ticket_id === op.ticket_id);
          if (next) next.revision = result.task.revision;
        });
      }
      const snapshot = await request('/sync/snapshot');
      let changed;
      await offlineState(s => {
        // The sync timestamp changes on every check; it is not a task data change.
        const { synced_at: previousTime, ...previousData } = s.snapshot || {};
        const { synced_at: currentTime, ...currentData } = snapshot;
        changed = JSON.stringify(previousData) !== JSON.stringify(currentData);
        const pending = new Set(s.operations.map(o => o.ticket_id));
        s.tasks = snapshot.tasks.concat(s.tasks.filter(t => pending.has(t.id) && !snapshot.tasks.some(n => n.id === t.id)));
        s.snapshot = snapshot;
      });
      if (changed) navigationReads.clear();
      lastError = '';
      const badge = snapshot.tasks.filter(t => t.today_rank !== null || t.due_date && t.due_date <= snapshot.planning.today || t.waiting_on && t.follow_up_date && t.follow_up_date <= snapshot.planning.today).length;
      try { if (badge) await navigator.setAppBadge?.(badge); else await navigator.clearAppBadge?.(); } catch {}
      dispatchEvent(new CustomEvent('taskhub-synced', { detail: { changed } }));
    } catch (error) {
      lastError = error.message;
      if (error.status === 401) { await offlineState(s => { s.locked = true; }); lastError = 'Sign in again to synchronize. Unsent work is retained.'; }
    } finally { window.taskhubSyncBusy = false; await updateStatus().catch(() => {}); }
  };
  syncing = (navigator.locks ? navigator.locks.request('taskhub-sync', run) : run()).finally(() => { syncing = null; });
  return syncing;
}
async function submitDrafts() {
  const { listDrafts, putDraft, deleteDraft } = await import('./draft-store.js');
  for (const draft of await listDrafts()) {
    if (!draft.autoSubmit || !draft.payload) continue;
    // The capture screen owns its live draft until the user leaves it.
    if (document.querySelector('main')?.dataset.captureId === draft.id) continue;
    try {
      if (!draft.ticket_id) {
        const task = await request('/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': draft.id }, body: JSON.stringify(draft.payload) });
        draft.ticket_id = task.id; await putDraft(draft);
      }
      for (const file of draft.files.filter(f => !f.uploaded)) {
        await request(`/tickets/${draft.ticket_id}/attachments`, { method: 'POST', headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name), 'Idempotency-Key': file.id }, body: file.bytes });
        file.uploaded = true; await putDraft(draft);
      }
      await deleteDraft(draft.id);
    } catch (error) {
      if (error.status === 400) { draft.autoSubmit = false; await putDraft(draft); continue; }
      throw error;
    }
  }
}
export async function updateStatus() {
  const state = await offlineState();
  const node = document.querySelector('.sync-status'); if (!node) return;
  node.hidden = !!state.snapshot && !lastError && !disconnected && navigator.onLine && state.operations.length === 0;
  const message = lastError || (disconnected || !navigator.onLine ? 'Offline · cached active tasks only' : 'On this device');
  node.replaceChildren(document.createTextNode(`${message}${state.operations.length ? ` · ${state.operations.length} pending` : ''}${state.snapshot ? ` · Synced ${new Date(state.snapshot.synced_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`));
  const link = document.createElement('a'); link.href = '#/sync'; link.textContent = 'Sync & details'; node.append(link);
}
export async function clearOffline() {
  navigationReads.clear();
  await offlineState(s => Object.assign(s, empty(), { locked: true }));
  await navigator.clearAppBadge?.();
}
export async function renderSync(view, ui) {
  const state = await offlineState();
  const { el, guard } = ui;
  const button = (text, fn) => el('button', { class: 'btn', onclick: guard(async event => {
    const control = event.currentTarget; control.disabled = true;
    try { await fn(); } finally { control.disabled = false; }
  }) }, text);
  const describe = (values, task, kind) => {
    const rows = [];
    if ('title' in values) rows.push(['Title', values.title]);
    if ('body' in values) rows.push([kind === 'note' ? 'New note' : 'Notes', values.body || 'No notes']);
    if ('status' in values) rows.push(['Progress', ['resolved', 'closed'].includes(values.status) ? 'Done' : values.status.replaceAll('_', ' ')]);
    if (kind === 'check') rows.push(['Checklist', `${task?.checklist?.find(item => item.id === values.item_id)?.title || 'Checklist step'} · ${values.completed ? 'Complete' : 'Not complete'}`]);
    if (values.checklist?.length) rows.push(['Checklist', values.checklist.map(item => `${item.completed ? '✓' : '○'} ${item.title}`).join('\n')]);
    return el('dl', { class: 'sync-comparison' }, ...rows.flatMap(([name, value]) => [el('dt', {}, name), el('dd', {}, value)]));
  };
  const stack = el('div', { class: 'settings-stack' });
  view.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'Offline & sync'), el('p', {}, 'Your saved work and changes waiting to send.'))), stack);
  stack.append(el('section', { class: 'card' }, el('h2', {}, `${state.operations.length} pending changes`),
    el('p', {}, 'Active tasks and checklists are saved on this device. Completed history, downloads, and administration require a connection. Offline search covers cached tasks only. Device data is not included in server backups.'),
    el('p', {}, state.snapshot ? `Last sync: ${new Date(state.snapshot.synced_at).toLocaleString()}` : 'Connect and sign in to save active tasks here.'),
    lastError && el('p', { role: 'alert' }, lastError),
    el('div', { class: 'settings-actions' }, button('Retry sync', async () => { await syncNow(); await ui.render(); }),
      state.locked && el('a', { href: '/login', class: 'btn' }, 'Sign in'))));
  for (const op of state.operations) {
    const task = state.tasks.find(t => t.id === op.ticket_id);
    const card = el('section', { class: 'card sync-conflict' }, el('h2', {}, task?.title || `Task ${op.ticket_id}`), el('p', {}, op.problem ? 'Needs your decision' : 'Waiting to sync'), el('h3', {}, 'Your change'), describe(op.changes, task, op.kind));
    if (op.problem) {
      if (op.problem.task) card.append(el('h3', {}, 'Server version'), describe(op.problem.task, op.problem.task));
      else card.append(el('p', {}, op.problem.state === 'invalid' ? `The server rejected this change: ${op.problem.error}. Export or recover it as a draft before discarding.` : 'This task was deleted. Export your changes below before discarding, or recover them as a draft.'));
      card.append(el('p', { class: 'muted' }, 'Discarding removes all pending changes for this task from this device.'), button(op.problem.task ? 'Use server version' : 'Discard local changes', async () => {
        if (!confirm('Discard all pending changes for this task?')) return;
        await offlineState(s => { s.operations = s.operations.filter(o => o.ticket_id !== op.ticket_id); }); await syncNow(); await ui.render();
      }));
      if (op.problem.task) card.append(button('Apply my changes', async () => {
        await offlineState(s => { const current = s.operations.find(o => o.id === op.id); current.revision = current.problem.task.revision; current.id = randomId(); delete current.problem; }); await syncNow(); await ui.render();
      }));
      else card.append(button('Recover as draft', async () => {
        const { putDraft } = await import('./draft-store.js');
        const local = overlay(state).find(t => t.id === op.ticket_id);
        const steps = local?.checklist?.map(item => `- [${item.completed ? 'x' : ' '}] ${item.title}`).join('\n');
        await putDraft({ id: randomId(), title: local?.title || 'Recovered task', body: [local?.body, ...state.operations.filter(o => o.ticket_id === op.ticket_id && o.kind === 'note').map(o => o.changes.body), steps].filter(Boolean).join('\n\n'), files: [], tags: '', priority: local?.priority || 'medium', updated_at: new Date().toISOString() });
        location.hash = '#/drafts';
      }));
    }
    stack.append(card);
  }
  stack.append(button('Export unsent changes', () => {
    const blob = new Blob([JSON.stringify(state.operations, null, 2)], { type: 'application/json' });
    const link = el('a', { href: URL.createObjectURL(blob), download: 'taskhub-unsent.json' }); link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }));
}
export function setupOffline() {
  const status = document.createElement('aside'); status.className = 'sync-status'; status.setAttribute('role', 'status');
  document.querySelector('.topbar')?.after(status);
  void updateStatus().catch(error => { status.textContent = error.message; });
  addEventListener('online', () => void syncNow());
  addEventListener('offline', () => { disconnected = true; void updateStatus(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void syncNow(); });
  void syncNow();
}
