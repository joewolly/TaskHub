// Updates are user initiated: never reload an editor when a worker arrives.
if ('serviceWorker' in navigator) {
  document.addEventListener('input', event => {
    const form = event.target.closest('form'); if (form) form.dataset.unsaved = 'true';
  });
  navigator.serviceWorker.register('/sw.js').then(registration => {
    const offer = () => {
      if (!navigator.serviceWorker.controller || !registration.waiting || document.querySelector('.update-notice')) return;
      const notice = document.createElement('aside'); notice.className = 'update-notice';
      notice.setAttribute('role', 'status');
      notice.append('A Task Hub update is ready. Save your work before updating.');
      const button = document.createElement('button'); button.className = 'btn'; button.textContent = 'Update now';
      button.onclick = () => {
        if (document.querySelector('#modal-root form, form[data-unsaved="true"]') || document.body.dataset.captureShell || /^#\/capture/.test(location.hash) || document.querySelector('.dashboard-capture-form input')?.value.trim()) {
          alert('Save or close this form before updating. Your saved drafts will be kept.'); return;
        }
        if (window.taskhubSyncBusy) { alert('Wait for synchronization to finish before updating.'); return; }
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
        registration.waiting?.postMessage({ type: 'ACTIVATE' });
      };
      notice.append(button); document.body.append(notice);
    };
    const ready = () => { offer(); registration.addEventListener('updatefound', () => {
      registration.installing?.addEventListener('statechange', offer);
    }); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
    registration.update().catch(() => {});
  }).catch(() => {});
}
