import { offlineState } from './offline.js';
export async function renderSettings(view, ui) {
  const { el, api, guard } = ui;
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const stack = el('div', { class: 'settings-stack' });
  view.append(el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, 'App & notifications'), el('p', {}, 'Make Task Hub feel at home on this device.'))), stack);
  stack.append(el('section', { class: 'card' }, el('h2', {}, 'At home on your iPhone'),
    el('p', {}, installed ? 'You are using the installed web app.' : 'In Safari, open Share, choose Add to Home Screen, and enable Open as Web App if shown. Then open Task Hub from its new icon.'),
    el('p', {}, 'Use your private HTTPS address. Away from home, connect to Tailscale to reach your server. Saved active tasks remain available offline.'),
    el('a', { href: '#/sync', class: 'btn' }, 'Offline data & pending changes')));
  const card = el('section', { class: 'card' }, el('h2', {}, 'Notifications on this device'));
  stack.append(card);
  let config;
  try { config = await api('/push/config'); }
  catch (error) { card.append(el('p', {}, error.message)); return; }
  if (!config.enabled) { card.append(el('p', {}, 'Notifications are not available yet. They need to be enabled by your server administrator.')); return; }
  const isIOS = /iPhone|iPad/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (!('PushManager' in window) || !('Notification' in window) || isIOS && !installed) {
    card.append(el('p', {}, 'Open Task Hub from your iPhone Home Screen to enable notifications. Other browsers need Web Push support.')); return;
  }
  let id = localStorage.getItem('taskhub-push-id');
  let preferences = { digest: true, individual: false, hour: 9, deadlines: true, overdue: true, followUps: true };
  if (id) {
    try { preferences = (await api(`/push/subscriptions/${id}`)).settings; }
    catch { id = null; localStorage.removeItem('taskhub-push-id'); }
  }
  const state = await offlineState();
  card.append(el('p', { class: 'notification-state' }, `Notifications: ${Notification.permission === 'denied' ? 'blocked' : id && Notification.permission === 'granted' ? 'on' : 'not enabled'}`), el('p', { class: 'muted' }, `Delivery times use ${state.snapshot?.planning.time_zone || 'the server timezone'}.`));
  if (Notification.permission === 'denied') card.append(el('p', {}, 'Notifications are blocked. Change notification permissions in iPhone Settings, then return here.'));
  const form = el('form');
  for (const [name, text] of [['digest', 'Daily summary'], ['individual', 'Individual task reminders'], ['deadlines', 'Tasks due today'], ['overdue', 'Overdue tasks'], ['followUps', 'Follow-ups']]) {
    const input = el('input', { type: 'checkbox', role: 'switch', name, checked: preferences[name] });
    form.append(el('div', { class: 'field setting-row' }, el('label', {}, el('span', {}, text), input)));
  }
  const hour = el('select', { name: 'hour', 'aria-label': 'Delivery hour' }, ...Array.from({ length: 24 }, (_, i) => el('option', { value: i, selected: i === preferences.hour }, `${String(i).padStart(2, '0')}:00`)));
  form.append(el('div', { class: 'field' }, el('label', {}, 'Delivery hour', hour)), el('p', { class: 'muted' }, 'Individual reminders are sent once per deadline or follow-up event. Push delivery depends on your device and network. Badge counts refresh when the app opens or receives a notification.'));
  const save = el('button', { type: 'submit', class: 'btn btn-primary', disabled: Notification.permission === 'denied' }, id ? 'Save preferences' : 'Enable notifications');
  const status = el('p', { role: 'status' }); form.append(save, status);
  form.addEventListener('submit', guard(async event => {
    event.preventDefault(); save.disabled = true;
    try {
      // Permission must be requested directly in this user gesture, before network work.
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (permission !== 'granted') { status.textContent = 'Notifications were not enabled. You can try again from settings.'; return; }
      const values = Object.fromEntries(new FormData(form));
      preferences = { hour: Number(values.hour), ...Object.fromEntries(['digest', 'individual', 'deadlines', 'overdue', 'followUps'].map(k => [k, values[k] === 'on'])) };
      const registration = await navigator.serviceWorker.ready;
      const key = Uint8Array.from(atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const result = await api('/push/subscriptions', { method: 'POST', body: { subscription: subscription.toJSON(), settings: preferences } });
      localStorage.setItem('taskhub-push-id', result.id); status.textContent = 'Notification preferences saved.';
      await ui.render();
      ui.toast('Notification preferences saved');
    } finally { save.disabled = Notification.permission === 'denied'; }
  }));
  card.append(form);
  if (id) card.append(el('div', { class: 'settings-actions' },
    el('button', { class: 'btn', onclick: guard(async () => { await api(`/push/subscriptions/${id}/test`, { method: 'POST' }); status.textContent = 'Test sent to the push service. Check your notifications.'; }) }, 'Send test'),
    el('button', { class: 'btn', onclick: guard(async () => {
      await api(`/push/subscriptions/${id}`, { method: 'DELETE' });
      const registration = await navigator.serviceWorker.ready;
      await (await registration.pushManager.getSubscription())?.unsubscribe();
      localStorage.removeItem('taskhub-push-id'); await navigator.clearAppBadge?.(); await ui.render(); ui.toast('Notifications disabled on this device');
    }) }, 'Disable on this device')));
}
