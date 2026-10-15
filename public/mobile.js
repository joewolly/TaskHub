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
  floating.href = '#/capture'; floating.className = 'mobile-add btn btn-primary';
  floating.textContent = '+ Add'; floating.setAttribute('aria-label', 'Add task');
  document.querySelector('.topbar')?.append(floating);
  if (document.body.dataset.captureShell) floating.remove();
  const morePanel = tabs?.querySelector('.more-nav');
  const moreMenu = morePanel?.querySelector('.more-nav-items');
  const moreTrigger = morePanel?.querySelector('summary');
  const scrim = document.createElement('button');
  scrim.className = 'mobile-menu-scrim'; scrim.hidden = true;
  scrim.tabIndex = -1; scrim.setAttribute('aria-label', 'Close More');
  scrim.onclick = () => { morePanel.open = false; };
  (document.querySelector('.topbar') || document.body).append(scrim);
  const closeMenu = document.createElement('button');
  closeMenu.type = 'button'; closeMenu.className = 'mobile-menu-close'; closeMenu.textContent = 'Done';
  closeMenu.onclick = () => { morePanel.open = false; };
  moreMenu?.prepend(closeMenu);
  let menuActive = false;
  const phone = matchMedia('(max-width: 760px)');
  const updateMenu = () => {
    const open = !!morePanel?.open && phone.matches;
    scrim.hidden = !open;
    document.body.classList.toggle('mobile-menu-open', open);
    document.getElementById('view')?.toggleAttribute('inert', open);
    floating.toggleAttribute('inert', open);
    tabs?.querySelectorAll(':scope > a').forEach(link => link.toggleAttribute('inert', open));
    if (open) {
      moreMenu.setAttribute('role', 'dialog');
      moreMenu.setAttribute('aria-modal', 'true');
      moreMenu.setAttribute('aria-label', 'More');
      if (!menuActive) closeMenu.focus({ preventScroll: true });
    } else {
      moreMenu?.removeAttribute('role'); moreMenu?.removeAttribute('aria-modal');
      if (menuActive) moreTrigger.focus({ preventScroll: true });
    }
    menuActive = open;
  };
  morePanel?.addEventListener('toggle', updateMenu);
  phone.addEventListener('change', updateMenu);
  document.addEventListener('keydown', event => {
    if (!morePanel?.open || !phone.matches) return;
    if (event.key === 'Escape') { event.preventDefault(); morePanel.open = false; }
    if (event.key === 'Tab') {
      const controls = [...moreMenu.querySelectorAll('a, button')].filter(n => n.getClientRects().length && !n.disabled);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  const positions = new Map(); let previous = location.hash, navigating = false;
  addEventListener('scroll', () => { if (!navigating) positions.set(previous, scrollY); }, { passive: true });
  addEventListener('hashchange', () => {
    if (/^#\/tickets\/\d+/.test(location.hash) && !/^#\/tickets\/\d+/.test(previous)) {
      sessionStorage.setItem('taskhub-list-return', previous || '#/');
    }
    navigating = true; previous = location.hash;
  });
  addEventListener('taskhub-render', () => {
    const capture = /^#\/(capture|paste)(\?|$)/.test(location.hash);
    document.body.classList.toggle('mobile-capturing', capture);
    floating.hidden = capture;
    const title = document.querySelector('.dashboard-head h1');
    if (title) title.textContent = phone.matches ? 'Home' : 'Dashboard';
    // Capture stays in the installed app and has an explicit way back.
    if (capture && !document.querySelector('#view > .capture-back')) {
      const back = document.createElement('a'); back.className = 'back-link capture-back';
      back.href = document.body.dataset.captureShell ? '/#/' : '#/'; back.textContent = '‹ Home';
      document.getElementById('view')?.prepend(back);
    }
    scrollTo(0, positions.get(location.hash) || 0);
    navigating = false;
    const active = tabs?.querySelector('a.active');
    tabs?.querySelectorAll('[aria-current]').forEach(n => n.removeAttribute('aria-current'));
    active?.setAttribute('aria-current', 'page');
    const isMain = !!tabs?.querySelector(':scope > a.active');
    tabs?.querySelector('summary')?.classList.toggle('active', !isMain);
  });
  const viewport = () => {
    const keyboard = !!window.visualViewport && innerHeight - window.visualViewport.height > 140;
    document.body.classList.toggle('keyboard-open', keyboard);
    document.documentElement.style.setProperty('--visible-height', `${window.visualViewport?.height || innerHeight}px`);
    document.documentElement.style.setProperty('--visible-top', `${window.visualViewport?.offsetTop || 0}px`);
  };
  window.visualViewport?.addEventListener('resize', viewport);
  window.visualViewport?.addEventListener('scroll', viewport); viewport();
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!installed && /iPhone|iPad/.test(navigator.userAgent) && !localStorage.getItem('taskhub-install-dismissed')) {
    const tip = document.createElement('aside'); tip.className = 'install-tip';
    const link = document.createElement('a'); link.href = '#/mobile-settings'; link.textContent = 'Keep Task Hub on your Home Screen →';
    const close = document.createElement('button'); close.textContent = 'Dismiss'; close.className = 'btn btn-sm';
    close.onclick = () => { localStorage.setItem('taskhub-install-dismissed', '1'); tip.remove(); };
    tip.append(link, close); document.querySelector('.topbar')?.after(tip);
  }
}
