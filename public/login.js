const form = document.getElementById('login-form');
const input = document.getElementById('password');
const error = document.getElementById('error');
const button = form.querySelector('button[type=submit]');
const toggle = document.getElementById('toggle-password');
toggle.addEventListener('click', () => {
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  toggle.textContent = show ? 'Hide' : 'Show';
  toggle.setAttribute('aria-pressed', String(show));
});
// HTTP redirects preserve the fragment, including a cold notification deep link.
if (/^#\//.test(location.hash) && !sessionStorage.getItem('taskhub-return')) {
  sessionStorage.setItem('taskhub-return', '/' + location.hash);
}

function showError(message) {
  error.textContent = message;
  error.hidden = false;
  input.select();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  button.disabled = true;
  button.textContent = 'Signing in…';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
    });

    if (res.ok) {
      // Full navigation rather than a hash change, so the app boots with the
      // session cookie already set.
      const target = sessionStorage.getItem('taskhub-return');
      sessionStorage.removeItem('taskhub-return');
      location.replace(target && /^\/(?:capture\.html)?#\//.test(target) ? target : '/');
      return;
    }

    const payload = await res.json().catch(() => ({}));
    showError(payload.error ?? `Sign in failed (HTTP ${res.status})`);
  } catch {
    showError('Could not reach the server.');
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});
