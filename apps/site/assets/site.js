// MSCD landing site behaviour. The page is complete without this file: it only adds
// the menu, the scroll reveals and the playback rules of the film (rules L-2 and L-4).
/* global window, document, IntersectionObserver, getComputedStyle, requestAnimationFrame, cancelAnimationFrame */
(() => {
  const root = document.documentElement;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canObserve = 'IntersectionObserver' in window;
  if (!reduce.matches && canObserve) root.classList.add('motion');

  // Navigation: paper style once the hero stage has scrolled away, and the small-screen menu.
  const nav = document.querySelector('[data-nav]');
  const hero = document.querySelector('[data-hero]');
  const burger = nav && nav.querySelector('[data-burger]');
  const menu = nav && nav.querySelector('[data-menu]');
  if (nav && hero) {
    const syncNav = () => {
      const heroBottom = hero.getBoundingClientRect().bottom;
      nav.classList.toggle('is-paper', heroBottom < nav.offsetHeight + 24);
    };
    window.addEventListener('scroll', syncNav, { passive: true });
    window.addEventListener('resize', syncNav);
    syncNav();
  }
  if (nav && burger && menu) {
    const setOpen = (open) => {
      if (open) nav.setAttribute('data-open', '');
      else nav.removeAttribute('data-open');
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? burger.dataset.labelClose : burger.dataset.labelOpen);
    };
    burger.addEventListener('click', () => setOpen(!nav.hasAttribute('data-open')));
    menu.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && nav.hasAttribute('data-open')) { setOpen(false); burger.focus(); }
    });
    document.addEventListener('click', (e) => {
      if (nav.hasAttribute('data-open') && !nav.contains(e.target)) setOpen(false);
    });
    window.addEventListener('resize', () => { if (window.innerWidth > 1080) setOpen(false); });
  }

  // The film plays only while it is on screen, the tab is visible and motion is allowed.
  // It starts at the poster frame, so the switch from poster to playback is invisible.
  document.querySelectorAll('[data-film]').forEach((film) => {
    let onScreen = false;
    let started = false;
    film.muted = true;
    const update = () => {
      const play = onScreen && document.visibilityState === 'visible' && !reduce.matches;
      if (play) {
        if (!started) {
          started = true;
          film.currentTime = Number(film.dataset.start || 0);
        }
        const p = film.play();
        if (p && p.catch) p.catch(() => {});
      } else if (!film.paused) {
        film.pause();
      }
    };
    if (canObserve) {
      new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; update(); }).observe(film);
    }
    document.addEventListener('visibilitychange', update);
    reduce.addEventListener('change', update);
  });

  // The chain under the hero answers the film: as the light pulse travels the thread, the link
  // below it brightens. The pulse sits at x = -0.25 + 1.5 * t of the frame width (t = 0..1 over
  // the 12 s loop, see media-src/thread.html). Runs only while the film plays.
  const film = document.querySelector('[data-hero] [data-film]');
  const chain = document.querySelector('[data-chain]');
  if (film && chain) {
    const links = [...chain.querySelectorAll('li')];
    const LOOP = 12;
    let raf = 0;
    let geo = null;
    const measure = () => {
      const box = film.getBoundingClientRect();
      const scale = Math.max(box.width / 1920, box.height / 1080);
      const width = 1920 * scale;
      const posX = parseFloat(getComputedStyle(film).objectPosition) || 0;
      const left = box.left + (box.width - width) * (posX / 100);
      const rects = links.map((li) => li.getBoundingClientRect());
      const oneRow = rects.every((r) => Math.abs(r.top - rects[0].top) < 2);
      const stage = film.closest('.stage').getBoundingClientRect();
      // One row: each link lights when the pulse is right above it. Wrapped rows (phones):
      // the links light one after another while the pulse crosses the visible stage.
      const dots = oneRow
        ? rects.map((r) => r.left + 5.5 - left)
        : rects.map((r, i) => stage.left - left + ((i + 0.5) / rects.length) * stage.width);
      geo = { left, width, dots };
    };
    const tick = () => {
      raf = 0;
      if (film.paused) return;
      if (!geo) measure();
      const t = (film.currentTime % LOOP) / LOOP;
      const x = (-0.25 + 1.5 * t) * geo.width;
      const spread = 0.075 * geo.width;
      links.forEach((li, i) => {
        const d = (x - geo.dots[i]) / spread;
        li.style.setProperty('--g', Math.exp(-d * d).toFixed(3));
      });
      raf = requestAnimationFrame(tick);
    };
    film.addEventListener('playing', () => { if (!raf) raf = requestAnimationFrame(tick); });
    film.addEventListener('pause', () => {
      cancelAnimationFrame(raf);
      raf = 0;
      links.forEach((li) => li.style.setProperty('--g', '0'));
    });
    window.addEventListener('resize', () => { geo = null; });
  }

  if (!canObserve) return;

  // Scroll reveals (only when motion is allowed; otherwise everything is already visible).
  if (!reduce.matches) {
    const revealer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        revealer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    document.querySelectorAll('.reveal, .viewer').forEach((el) => revealer.observe(el));
  }

  // Looping diagram details run only while their section is on screen and the tab is visible.
  const live = [...document.querySelectorAll('[data-live]')];
  const seen = new Set();
  const syncLive = () => live.forEach((el) => el.classList.toggle('is-live', seen.has(el) && document.visibilityState === 'visible'));
  const liveObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => (entry.isIntersecting ? seen.add(entry.target) : seen.delete(entry.target)));
    syncLive();
  });
  live.forEach((el) => liveObserver.observe(el));
  document.addEventListener('visibilitychange', syncLive);
})();
