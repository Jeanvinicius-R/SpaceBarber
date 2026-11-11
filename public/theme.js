(() => {
  const key = 'spacebarber-theme';
  let theme = 'light';
  try { if (localStorage.getItem(key) === 'dark') theme = 'dark'; } catch {}
  function apply(value) {
    theme = value === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0a0a0a' : '#ffffff');
    document.querySelectorAll('[data-action="toggle-theme"]').forEach(button => {
      const dark = theme === 'dark';
      button.setAttribute('aria-label', dark ? 'Ativar tema claro' : 'Ativar tema escuro');
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('title', dark ? 'Ativar tema claro' : 'Ativar tema escuro');
      button.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${dark ? '<path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/>' : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>'}</svg><span>${dark ? 'Escuro' : 'Claro'}</span>`;
    });
  }
  window.SpaceBarberTheme = { refresh: () => apply(theme) };
  apply(theme);
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-action="toggle-theme"]')) return;
    apply(theme === 'dark' ? 'light' : 'dark');
    try { localStorage.setItem(key, theme); } catch {}
  });
  window.addEventListener('storage', event => { if (event.key === key) apply(event.newValue); });
})();
