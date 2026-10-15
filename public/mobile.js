// Shared phone shell. No framework: the existing routes remain the source of truth.
export function setupMobile() {
  const tabs = document.querySelector('.topbar .tabs');
  if (tabs) {
    const icons = {
      dashboard: '<path d="m3 10 9-7 9 7v10H3Z M9 20v-7h6v7"/>',
      today: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 11h16m-12 5h3"/>',
      inbox: '<path d="M3 14 6 4h12l3 10v6H3Z M3 14h5l2 3h4l2-3h5"/>',
      tasks: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    };
    for (const link of tabs.querySelectorAll(':scope > a')) {
      if (!link.dataset.tab) continue;
      const label = link.dataset.tab === 'dashboard' ? 'Home' : link.textContent;
      link.replaceChildren();
      const icon = document.createElement('span');
      icon.className = 'tab-icon';
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icons[link.dataset.tab] || ''}</svg>`;
      icon.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span'); text.textContent = label;
      link.append(icon, text);
    }
    const more = tabs.querySelector('summary');
    if (more) more.innerHTML = '<span class="tab-icon" aria-hidden="true">···</span><span>More</span>';
    const menu = tabs.querySelector('.more-nav-items');
    for (const [href, text] of [['#/mobile-settings', 'App & notifications'], ['#/sync', 'Offline & sync']]) {
      const link = document.createElement('a'); link.href = href; link.textContent = text;
      menu?.prepend(link);
    }
  }
  const floating = document.createElement('a');
  floating.href = '/capture.html#/capture'; floating.className = 'mobile-add btn btn-primary';
  floating.textContent = '+ Add task'; document.body.append(floating);
  if (document.body.dataset.captureShell) floating.remove();
  const positions = new Map(); let previous = location.hash, navigating = false;
  addEventListener('scroll', () => { if (!navigating) positions.set(previous, scrollY); }, { passive: true });
  addEventListener('hashchange', () => {
    if (/^#\/tickets\/\d+/.test(location.hash) && !/^#\/tickets\/\d+/.test(previous)) {
      sessionStorage.setItem('taskhub-list-return', previous || '#/');
    }
    navigating = true; previous = location.hash;
  });
  addEventListener('taskhub-render', () => {
    scrollTo(0, positions.get(location.hash) || 0);
    navigating = false;
    const active = tabs?.querySelector('a.active');
    tabs?.querySelectorAll('[aria-current]').forEach(n => n.removeAttribute('aria-current'));
    active?.setAttribute('aria-current', 'page');
    const isMain = !!tabs?.querySelector(':scope > a.active');
    tabs?.querySelector('summary')?.classList.toggle('active', !isMain);
  });
  const viewport = () => {
    const keyboard = !!visualViewport && innerHeight - visualViewport.height > 140;
    document.body.classList.toggle('keyboard-open', keyboard);
    document.documentElement.style.setProperty('--visible-height', `${visualViewport?.height || innerHeight}px`);
  };
  visualViewport?.addEventListener('resize', viewport); viewport();
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!installed && /iPhone|iPad/.test(navigator.userAgent) && !localStorage.getItem('taskhub-install-dismissed')) {
    const tip = document.createElement('aside'); tip.className = 'install-tip';
    const link = document.createElement('a'); link.href = '#/mobile-settings'; link.textContent = 'Keep Task Hub on your Home Screen →';
    const close = document.createElement('button'); close.textContent = 'Dismiss'; close.className = 'btn btn-sm';
    close.onclick = () => { localStorage.setItem('taskhub-install-dismissed', '1'); tip.remove(); };
    tip.append(link, close); document.querySelector('.topbar')?.after(tip);
  }
}
