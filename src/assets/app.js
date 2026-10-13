(() => {
  const root = document.documentElement;
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // ---------- Theme ----------
  const isDark = () => root.dataset.theme
    ? root.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  document.querySelector('.theme-toggle')?.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    root.dataset.theme = next;
    store.set('theme', next);
  });

  // ---------- Language ----------
  const lang = () => root.dataset.lang || 'en';
  document.querySelector('.lang-toggle')?.addEventListener('click', () => {
    const next = lang() === 'en' ? 'de' : 'en';
    root.dataset.lang = next;
    root.lang = next;
    store.set('lang', next);
    if (lb?.classList.contains('open')) renderCaption();
    document.dispatchEvent(new CustomEvent('langchange'));
  });

  // ---------- Header over hero ----------
  const hero = document.querySelector('.hero');
  if (hero) {
    new IntersectionObserver(([e]) => document.body.classList.toggle('scrolled', !e.isIntersecting), {
      rootMargin: '-68px 0px 0px 0px',
    }).observe(hero);
  }

  // ---------- Lightbox ----------
  const icon = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  let lb, items = [], index = 0;

  function build() {
    lb = document.createElement('div');
    lb.className = 'lb';
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.innerHTML = `
      <div class="lb-top"><span class="lb-count"></span><button class="lb-close" aria-label="Close">${icon('M5 5l14 14M19 5L5 19')}</button></div>
      <div class="lb-stage">
        <img class="lb-img" alt="">
        <button class="lb-nav lb-prev" aria-label="Previous">${icon('M15 4l-8 8 8 8')}</button>
        <button class="lb-nav lb-next" aria-label="Next">${icon('M9 4l8 8-8 8')}</button>
      </div>
      <div class="lb-caption"><div class="lb-title"></div><div class="lb-exif"></div></div>`;
    document.body.appendChild(lb);
    lb.querySelector('.lb-close').onclick = close;
    lb.querySelector('.lb-prev').onclick = () => go(-1);
    lb.querySelector('.lb-next').onclick = () => go(1);
    lb.querySelector('.lb-stage').addEventListener('click', (e) => { if (e.target.classList.contains('lb-stage')) close(); });

    let x0 = null, y0 = null;
    const stage = lb.querySelector('.lb-stage');
    stage.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
      else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) close();
      x0 = null;
    });
  }

  function renderCaption() {
    const t = items[index];
    const l = lang();
    const album = t.dataset[`album${l === 'de' ? 'De' : 'En'}`];
    const date = t.dataset[`date${l === 'de' ? 'De' : 'En'}`];
    const title = lb.querySelector('.lb-title');
    title.innerHTML = '';
    if (album && !location.pathname.startsWith(t.dataset.albumHref)) {
      const a = document.createElement('a');
      a.href = t.dataset.albumHref;
      a.textContent = album;
      title.append(a);
    } else if (album) title.textContent = album;
    if (date) title.append(document.createTextNode(`${album ? ' · ' : ''}${date}`));
    lb.querySelector('.lb-exif').textContent = [t.dataset.exif, t.dataset.lens].filter(Boolean).join('  —  ');
    lb.querySelector('.lb-count').textContent = `${index + 1} / ${items.length}`;
  }

  function show(i) {
    index = (i + items.length) % items.length;
    const src = items[index].querySelector('img');
    const img = lb.querySelector('.lb-img');
    img.classList.remove('in');
    img.onload = () => img.classList.add('in');
    img.sizes = '100vw';
    img.srcset = src.srcset;
    img.src = items[index].href;
    if (img.complete) img.classList.add('in');
    renderCaption();
    // Preload neighbours
    for (const d of [1, -1]) {
      const n = items[(index + d + items.length) % items.length];
      if (n) { const p = new Image(); p.sizes = '100vw'; p.srcset = n.querySelector('img').srcset; }
    }
    history.replaceState(null, '', `#${items[index].dataset.id}`);
  }

  function open(tile) {
    if (!lb) build();
    items = [...tile.closest('.grid').querySelectorAll('.tile')];
    history.pushState({ lb: true }, '', `#${tile.dataset.id}`);
    show(items.indexOf(tile));
    lb.classList.add('open');
    document.body.classList.add('lb-lock');
    lb.querySelector('.lb-close').focus({ preventScroll: true });
  }

  function close(fromHistory) {
    if (!lb?.classList.contains('open')) return;
    lb.classList.remove('open');
    document.body.classList.remove('lb-lock');
    const tile = items[index];
    if (fromHistory !== true) {
      if (history.state?.lb) history.back();
      else history.replaceState(null, '', location.pathname);
    }
    tile?.focus({ preventScroll: true });
  }

  const go = (d) => show(index + d);

  document.addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    open(tile);
  });
  document.addEventListener('keydown', (e) => {
    if (!lb?.classList.contains('open')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
  });
  addEventListener('popstate', () => close(true));

  // Deep link: /album/x/#<photo-id>
  const target = location.hash.length > 1 && document.querySelector(`.tile[data-id="${CSS.escape(location.hash.slice(1))}"]`);
  if (target) {
    history.replaceState(null, '', location.pathname);
    open(target);
  }
})();
