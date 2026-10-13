// HTML templates. Text in both languages is rendered side by side and the
// inactive language is hidden with CSS, so switching is instant.

// Base path when the site lives in a subfolder (e.g. GitHub Pages: /Website-MAC).
let BASE = '';
export const setBase = (b) => { BASE = String(b || '').replace(/\/+$/, ''); };
const withBase = (html) => BASE ? html
  .replace(/(\s(?:href|src|srcset|content|data-album-href)=")\/(?!\/)/g, `$1${BASE}/`)
  .replace(/, \/img\//g, `, ${BASE}/img/`) : html;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STRINGS = {
  latest: { en: 'Latest', de: 'Neueste' },
  albums: { en: 'Albums', de: 'Alben' },
  about: { en: 'About', de: 'Über mich' },
  contact: { en: 'Contact', de: 'Kontakt' },
  allAlbums: { en: 'All albums', de: 'Alle Alben' },
  imprint: { en: 'Imprint', de: 'Impressum' },
  previous: { en: 'Previous', de: 'Vorheriges' },
  next: { en: 'Next', de: 'Nächstes' },
  notFound: { en: 'This page doesn’t exist.', de: 'Diese Seite gibt es nicht.' },
  home: { en: 'Back home', de: 'Zur Startseite' },
  empty: { en: 'No photos yet.', de: 'Noch keine Fotos.' },
  upload: { en: 'Upload your first photos →', de: 'Lade deine ersten Fotos hoch →' },
};

// Bilingual text: accepts a {en, de} object, a plain string, or a STRINGS key.
const t = (v) => {
  const o = typeof v === 'string' ? (STRINGS[v] || { en: v, de: v }) : (v || {});
  const en = o.en ?? o.de ?? '', de = o.de ?? o.en ?? '';
  if (en === de) return esc(en);
  return `<span lang="en">${esc(en)}</span><span lang="de">${esc(de)}</span>`;
};

const paragraphs = (o) => {
  const one = (s) => String(s || '').split(/\n+/).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('');
  const en = one(o?.en ?? o?.de), de = one(o?.de ?? o?.en);
  if (en === de) return en;
  return `<div lang="en">${en}</div><div lang="de">${de}</div>`;
};

const count = (n) => t({ en: `${n} ${n === 1 ? 'photo' : 'photos'}`, de: `${n} ${n === 1 ? 'Foto' : 'Fotos'}` });

const srcset = (p) => p.sizes.map((s) => `/img/${s.file} ${s.w}w`).join(', ');
const smallest = (p) => `/img/${p.sizes[0].file}`;
const largest = (p) => `/img/${p.sizes[p.sizes.length - 1].file}`;

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return t({
    en: d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    de: d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }),
  });
}

const ICONS = {
  sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>',
};

function layout(ctx, { title, body, bodyClass = '', description, image, head = '', scripts = ['/assets/app.js'] }) {
  const { site } = ctx;
  const lang = site.defaultLanguage === 'de' ? 'de' : 'en';
  const pageTitle = title ? `${title} — ${site.name}` : `${site.name} — ${site.tagline?.[lang] || ''}`;
  const desc = description || site.description?.[lang] || '';
  return withBase(`<!doctype html>
<html lang="${lang}" data-lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(desc)}">
${image ? `<meta property="og:image" content="${esc(largest(image))}">` : ''}
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="11" fill="none" stroke="#888" stroke-width="2.5"/><circle cx="16" cy="16" r="4" fill="#888"/></svg>')}">
<link rel="preload" href="/fonts/cormorant-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/style.css">
${head}<script>
(function(){var d=document.documentElement;try{var th=localStorage.getItem('theme');if(th)d.dataset.theme=th;var l=localStorage.getItem('lang');if(!l){var n=(navigator.language||'').slice(0,2);if(n==='de'||n==='en')l=n}if(l){d.dataset.lang=l;d.lang=l}}catch(e){}})();
</script>
<noscript><style>.tile img,.card img,.hero img{opacity:1}</style></noscript>
</head>
<body class="${bodyClass}">
<header class="site-header">
  <a class="brand" href="/">${esc(site.name)}</a>
  <nav class="nav">
    <a href="/#latest">${t('latest')}</a>
    <a href="/#albums">${t('albums')}</a>
    <a href="/about/">${t('about')}</a>
    <span class="nav-sep" aria-hidden="true"></span>
    <button class="lang-toggle" type="button" aria-label="Language / Sprache"><span class="l-en">EN</span><span class="l-de">DE</span></button>
    <button class="theme-toggle" type="button" aria-label="Toggle dark mode">${ICONS.moon}${ICONS.sun}</button>
  </nav>
</header>
<main>
${body}
</main>
<footer class="site-footer">
  <span>© ${ctx.year} ${esc(site.name)}</span>
  <span class="footer-links">
    ${site.contact?.instagram ? `<a href="https://instagram.com/${esc(site.contact.instagram.replace(/^@/, ''))}" rel="noopener">Instagram</a>` : ''}
    ${site.contact?.email ? `<a href="mailto:${esc(site.contact.email)}">${t('contact')}</a>` : ''}
    ${site.imprint?.en || site.imprint?.de ? `<a href="/imprint/">${t('imprint')}</a>` : ''}
  </span>
</footer>
${scripts.map((s) => `<script src="${s}" defer></script>`).join('\n')}
</body>
</html>`);
}

function tile(p, { showAlbum = false, rowWidth = 420 } = {}) {
  const r = p.w / p.h;
  const album = p.album;
  const caption = [p.exif.line, p.exif.lens].filter(Boolean).join(' — ');
  return `<a class="tile" href="${largest(p)}" style="--r:${r.toFixed(4)};flex-grow:${(r * 100).toFixed(2)};--c:${p.color}"
  data-id="${p.hash}" data-exif="${esc(p.exif.line || '')}" data-lens="${esc(p.exif.lens || '')}"
  data-date-en="${esc(p.exif.date ? new Date(p.exif.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '')}"
  data-date-de="${esc(p.exif.date ? new Date(p.exif.date).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }) : '')}"
  ${album ? `data-album-en="${esc(album.title.en)}" data-album-de="${esc(album.title.de)}" data-album-href="/album/${album.slug}/"` : ''}>
  <img src="${smallest(p)}" srcset="${srcset(p)}" sizes="${Math.ceil(r * rowWidth)}px" width="${p.w}" height="${p.h}" loading="lazy" decoding="async" alt="${esc(album ? `${album.title.en} — ${p.name}` : p.name)}" onload="this.classList.add('in')">
  ${caption || (showAlbum && album) ? `<span class="tile-info">${showAlbum && album ? `<span class="tile-album">${t(album.title)}</span>` : ''}${esc(p.exif.line || '')}</span>` : ''}
</a>`;
}

const grid = (photos, opts) => `<div class="grid">${photos.map((p) => tile(p, opts)).join('')}</div>`;

export function home(ctx) {
  const { site, albums, latest, hero } = ctx;
  if (!latest.length) {
    return layout(ctx, { body: `<section class="empty" id="latest"><span id="albums"></span><h1 class="display">${esc(site.name)}</h1><p>${t('empty')}</p><p><a href="/admin/">${t('upload')}</a></p></section>` });
  }
  const body = `
<section class="hero" style="--c:${hero.color}">
  <img src="${smallest(hero)}" srcset="${srcset(hero)}" sizes="100vw" alt="" fetchpriority="high" decoding="async" onload="this.classList.add('in')">
  <div class="hero-text">
    <h1 class="display">${esc(site.name)}</h1>
    <p class="eyebrow">${t(site.tagline)}</p>
  </div>
  <a class="hero-scroll" href="#latest" aria-label="Scroll"><span></span></a>
</section>

<section class="section" id="latest">
  <div class="section-head">
    <h2 class="display">${t('latest')}</h2>
    ${site.description ? `<p class="lede">${t(site.description)}</p>` : ''}
  </div>
  ${grid(latest, { showAlbum: true })}
</section>

${albums.length ? `<section class="section" id="albums">
  <div class="section-head"><h2 class="display">${t('albums')}</h2></div>
  <div class="cards">
    ${albums.map((a) => `<a class="card" href="/album/${a.slug}/">
      <div class="card-img" style="--c:${a.cover.color}"><img src="${smallest(a.cover)}" srcset="${srcset(a.cover)}" sizes="(max-width: 700px) 100vw, 33vw" alt="" loading="lazy" decoding="async" onload="this.classList.add('in')"></div>
      <div class="card-meta"><h3>${t(a.title)}</h3><span class="eyebrow">${count(a.photos.length)}</span></div>
    </a>`).join('')}
  </div>
</section>` : ''}`;
  return layout(ctx, { body, bodyClass: 'has-hero', image: hero });
}

export function album(ctx, a, prev, next) {
  const body = `
<section class="section album-head">
  <a class="eyebrow back" href="/#albums">← ${t('allAlbums')}</a>
  <h1 class="display">${t(a.title)}</h1>
  <p class="eyebrow">${count(a.photos.length)}${a.newest ? ` · ${formatDate(a.newest)}` : ''}</p>
  ${a.description ? `<div class="lede">${paragraphs(a.description)}</div>` : ''}
</section>
<section class="section section-tight">
  ${grid(a.photos)}
</section>
${prev || next ? `<nav class="section pager">
  ${prev ? `<a href="/album/${prev.slug}/"><span class="eyebrow">← ${t('previous')}</span><span class="display">${t(prev.title)}</span></a>` : '<span></span>'}
  ${next ? `<a class="pager-next" href="/album/${next.slug}/"><span class="eyebrow">${t('next')} →</span><span class="display">${t(next.title)}</span></a>` : '<span></span>'}
</nav>` : ''}`;
  return layout(ctx, { title: a.title.en, body, image: a.cover });
}

export function about(ctx) {
  const { site, aboutPhoto } = ctx;
  const c = site.contact || {};
  const body = `
<section class="section about">
  ${aboutPhoto ? `<div class="about-photo" style="--c:${aboutPhoto.color}"><img src="${smallest(aboutPhoto)}" srcset="${srcset(aboutPhoto)}" sizes="(max-width: 800px) 100vw, 40vw" alt="${esc(site.name)}" onload="this.classList.add('in')"></div>` : ''}
  <div class="about-text">
    <h1 class="display">${t('about')}</h1>
    <div class="prose">${paragraphs(site.about?.text)}</div>
    ${c.email || c.instagram ? `<div class="contact">
      <p class="eyebrow">${t('contact')}</p>
      ${c.email ? `<a class="contact-link" href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}
      ${c.instagram ? `<a class="contact-link" href="https://instagram.com/${esc(c.instagram.replace(/^@/, ''))}" rel="noopener">@${esc(c.instagram.replace(/^@/, ''))}</a>` : ''}
    </div>` : ''}
  </div>
</section>`;
  return layout(ctx, { title: 'About', body, image: aboutPhoto });
}

export function imprint(ctx) {
  const body = `<section class="section prose-page"><h1 class="display">${t('imprint')}</h1><div class="prose">${paragraphs(ctx.site.imprint)}</div></section>`;
  return layout(ctx, { title: 'Imprint', body });
}

export function notFound(ctx) {
  const body = `<section class="empty"><h1 class="display">404</h1><p>${t('notFound')}</p><p><a href="/">${t('home')}</a></p></section>`;
  return layout(ctx, { title: '404', body });
}

export function admin(ctx, repo) {
  const body = `<div id="admin" class="admin"></div>
<script>window.ADMIN_CONFIG=${JSON.stringify({ ...repo, base: BASE }).replace(/</g, '\\u003c')};</script>`;
  return layout(ctx, {
    title: 'Admin', body, bodyClass: 'is-admin', scripts: ['/assets/app.js', '/assets/exif-clean.js', '/assets/admin.js'],
    head: '<link rel="stylesheet" href="/assets/admin.css">\n<meta name="robots" content="noindex">\n',
  });
}
