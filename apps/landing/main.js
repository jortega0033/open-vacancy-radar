// Open Vacancy Radar landing page: progressive enhancement only.
// The page is complete without this file; it adds scroll reveals, the radar pause control,
// offscreen animation pausing, the copy button, and a pointer glow on feature panels.
(() => {
  'use strict';

  const root = document.documentElement;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hasIO = 'IntersectionObserver' in window;

  /* Theme toggle. The inline head script already set data-ovr before paint; this only handles
     the click and persists the choice. */
  const themeToggle = document.querySelector('[data-theme-toggle]');
  if (themeToggle) {
    const syncLabel = () => {
      const isLight = root.getAttribute('data-ovr') === 'light';
      themeToggle.setAttribute('aria-label', isLight ? 'Switch to dark theme' : 'Switch to light theme');
    };
    syncLabel();
    themeToggle.addEventListener('click', () => {
      const next = root.getAttribute('data-ovr') === 'light' ? 'dark' : 'light';
      root.setAttribute('data-ovr', next);
      syncLabel();
      try {
        localStorage.setItem('ovr-landing-theme', next);
      } catch { /* localStorage unavailable: the choice just won't persist across visits. */ }
    });
  }

  /* Scroll reveals. Hidden states only exist under .reveal-ready, which is set here, so content
     is never hidden when JS fails or when the visitor prefers reduced motion. */
  const revealTargets = document.querySelectorAll('[data-reveal]');
  if (!reduceMotion.matches && hasIO && revealTargets.length) {
    root.classList.add('reveal-ready');
    const revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-in');
          revealObserver.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    revealTargets.forEach((el) => revealObserver.observe(el));
  }

  /* Pause ambient animations while they are offscreen. */
  if (hasIO) {
    const ambientObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) entry.target.classList.toggle('is-offscreen', !entry.isIntersecting);
    });
    document.querySelectorAll('[data-radar], [data-ambient]').forEach((el) => ambientObserver.observe(el));
  }

  /* Radar pause control (WCAG 2.2.2: moving content that runs longer than 5s can be paused). */
  const radar = document.querySelector('[data-radar]');
  const toggle = document.querySelector('[data-radar-toggle]');
  const toggleLabel = document.querySelector('[data-radar-toggle-label]');
  if (radar && toggle) {
    toggle.addEventListener('click', () => {
      const paused = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', String(paused));
      radar.dataset.paused = String(paused);
      if (toggleLabel) toggleLabel.textContent = paused ? 'Resume animation' : 'Pause animation';
    });
  }

  /* Copy-to-clipboard. */
  document.querySelectorAll('[data-copy]').forEach((button) => {
    const label = button.querySelector('[data-copy-label]');
    let timer = 0;
    button.addEventListener('click', async () => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(button.dataset.copy || '');
        ok = true;
      } catch {
        // ok already false
      }
      if (label) label.textContent = ok ? 'Copied' : 'Select and copy';
      button.classList.toggle('is-copied', ok);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (label) label.textContent = 'Copy';
        button.classList.remove('is-copied');
      }, 2000);
    });
  });

  /* Pointer-following glow on feature panels, fine pointers only. */
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    document.querySelectorAll('[data-glow]').forEach((panel) => {
      panel.addEventListener('pointermove', (event) => {
        const rect = panel.getBoundingClientRect();
        panel.style.setProperty('--mx', `${event.clientX - rect.left}px`);
        panel.style.setProperty('--my', `${event.clientY - rect.top}px`);
      });
    });
  }

  /* Top bar border once the page has scrolled. */
  const topbar = document.querySelector('[data-topbar]');
  if (topbar) {
    let ticking = false;
    const update = () => {
      topbar.classList.toggle('is-scrolled', window.scrollY > 8);
      ticking = false;
    };
    window.addEventListener(
      'scroll',
      () => {
        if (!ticking) {
          ticking = true;
          window.requestAnimationFrame(update);
        }
      },
      { passive: true },
    );
    update();
  }
})();
