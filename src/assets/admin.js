// Admin: sign in with GitHub, drag & drop photos, manage albums.
// Every change is a commit to the GitHub repository; Netlify then rebuilds the site.
(() => {
  const cfg = window.ADMIN_CONFIG || {};
  const el = document.getElementById('admin');
  const API = 'https://api.github.com';
  const ACCEPT = /\.(jpe?g|png|webp|tiff?|avif)$/i;
  const T = (en, de) => en === de ? esc(en) : `<span lang="en">${esc(en)}</span><span lang="de">${esc(de)}</span>`;
  const L = (en, de) => (document.documentElement.dataset.lang === 'de' ? de : en);
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  const ss = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  // ---------- Token from OAuth redirect ----------
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('token')) ss.set('gh_token', hash.get('token'));
  const loginError = hash.get('error');
  if (location.hash) history.replaceState(null, '', location.pathname);

  let token = ss.get('gh_token');
  let user = null;
  let files = [];      // [{path, sha}] under photos/
  let index = {};      // published thumbnails: { "Album/file.jpg": { thumb } }
  let siteHero = '';
  const localPreviews = new Map(); // path -> object URL for photos uploaded this session
  let queue = [];      // [{file, album?, url, progress}]
  let busy = false;
  const open = new Set(); // expanded album folders

  // ---------- GitHub API ----------
  async function gh(path, { method = 'GET', body } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (res.status === 401) { signOut(); throw new Error(L('Session expired, please sign in again.', 'Sitzung abgelaufen, bitte erneut anmelden.')); }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) { const e = new Error(data?.message || `GitHub error ${res.status}`); e.status = res.status; throw e; }
    return data;
  }

  const readAsBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

  // Upload one file as a git blob, with progress.
  function uploadBlob(base64, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API}/repos/${cfg.repo}/git/blobs`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Accept', 'application/vnd.github+json');
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText).sha);
        else reject(new Error(JSON.parse(xhr.responseText || '{}').message || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error(L('Network error during upload', 'Netzwerkfehler beim Hochladen')));
      xhr.send(JSON.stringify({ content: base64, encoding: 'base64' }));
    });
  }

  // One commit on top of the branch; retries if the branch moved meanwhile.
  async function commit(message, entries) {
    for (let attempt = 0; ; attempt++) {
      const ref = await gh(`/repos/${cfg.repo}/git/ref/heads/${cfg.branch}`);
      const parent = await gh(`/repos/${cfg.repo}/git/commits/${ref.object.sha}`);
      const tree = await gh(`/repos/${cfg.repo}/git/trees`, { method: 'POST', body: { base_tree: parent.tree.sha, tree: entries } });
      const c = await gh(`/repos/${cfg.repo}/git/commits`, { method: 'POST', body: { message, tree: tree.sha, parents: [ref.object.sha] } });
      try {
        await gh(`/repos/${cfg.repo}/git/refs/heads/${cfg.branch}`, { method: 'PATCH', body: { sha: c.sha } });
        await loadTree(tree.sha);
        watchDeploy(c.sha);
        return c.sha;
      } catch (err) {
        if (err.status !== 422 || attempt >= 2) throw err;
      }
    }
  }

  async function loadTree(treeSha) {
    const sha = treeSha || (await gh(`/repos/${cfg.repo}/branches/${encodeURIComponent(cfg.branch)}`)).commit.commit.tree.sha;
    const tree = await gh(`/repos/${cfg.repo}/git/trees/${sha}?recursive=1`);
    files = tree.tree.filter((n) => n.type === 'blob' && n.path.startsWith('photos/')).map((n) => ({ path: n.path, sha: n.sha }));
  }

  async function readRepoFile(path) {
    try {
      const f = await gh(`/repos/${cfg.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(cfg.branch)}`);
      return new TextDecoder().decode(Uint8Array.from(atob(f.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }
  const readJson = async (path) => { try { return JSON.parse(await readRepoFile(path) || '{}'); } catch { return {}; } };

  // ---------- Derived data ----------
  function albums() {
    const map = new Map();
    for (const f of files) {
      const parts = f.path.split('/');
      if (parts.length !== 3) continue;
      const [, folder, name] = parts;
      if (folder.startsWith('.') || folder.startsWith('_')) continue;
      if (!map.has(folder)) map.set(folder, { folder, photos: [], conf: null });
      if (ACCEPT.test(name)) map.get(folder).photos.push({ ...f, name, src: `${folder}/${name}` });
      if (name === '_album.json') map.get(folder).confSha = f.sha;
    }
    return [...map.values()].sort((a, b) => a.folder.localeCompare(b.folder));
  }

  const cleanName = (s) => s.normalize('NFC').trim().replace(/[\\/]+/g, '-').replace(/^[._]+/, '').replace(/\s+/g, ' ').slice(0, 80);
  const cleanFile = (s) => {
    const m = s.normalize('NFC').match(/^(.*?)(\.[^.]+)?$/);
    const base = m[1].replace(/\s+/g, '-').replace(/[^\p{L}\p{N}._-]/gu, '').replace(/^[._]+/, '') || 'photo';
    return base + (m[2] || '').toLowerCase();
  };
  const fmtSize = (b) => b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`;

  // ---------- Status bar ----------
  let statusTimer;
  function status(html, kind = 'info', sticky = false) {
    const bar = el.querySelector('.adm-status');
    if (!bar) return;
    clearTimeout(statusTimer);
    bar.className = `adm-status is-${kind}`;
    bar.innerHTML = html;
    bar.hidden = false;
    if (!sticky) statusTimer = setTimeout(() => { bar.hidden = true; }, 7000);
  }

  let watching = null;
  function watchDeploy(sha) {
    watching = sha;
    const started = Date.now();
    status(`<span class="spin"></span>${T('Saved. Your website is rebuilding, this takes about 1–2 minutes…', 'Gespeichert. Deine Website wird neu gebaut, das dauert etwa 1–2 Minuten …')}`, 'info', true);
    const tick = async () => {
      if (watching !== sha) return;
      try {
        const v = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => r.json());
        if (v.commit === sha) {
          index = await fetch(`/data/photos.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => index);
          renderAlbums();
          status(`${T('Live! Your changes are on the website.', 'Online! Deine Änderungen sind auf der Website.')} <a href="/" target="_blank">${T('View site →', 'Website ansehen →')}</a>`, 'ok', true);
          return;
        }
      } catch { /* not deployed yet */ }
      if (Date.now() - started < 8 * 60e3) setTimeout(tick, 6000);
      else status(T('Saved to GitHub. The rebuild is taking longer than usual — check Netlify if it doesn’t show up.', 'Auf GitHub gespeichert. Der Build dauert länger als üblich — prüfe Netlify, falls nichts erscheint.'), 'info', true);
    };
    setTimeout(tick, 15000);
  }

  // ---------- Views ----------
  function signOut() { ss.set('gh_token', null); token = null; user = null; render(); }

  function render() {
    if (!cfg.repo) {
      el.innerHTML = `<div class="adm-center"><h1 class="display">Admin</h1>
        <p>${T('This site is not connected to a GitHub repository yet. Follow the setup steps in README.md.', 'Diese Website ist noch nicht mit einem GitHub-Repository verbunden. Folge den Schritten in README.md.')}</p></div>`;
      return;
    }
    if (!token) {
      const msg = loginError === 'not_allowed'
        ? T('This GitHub account is not allowed.', 'Dieses GitHub-Konto ist nicht berechtigt.')
        : loginError ? T('Sign-in failed, please try again.', 'Anmeldung fehlgeschlagen, bitte erneut versuchen.') : '';
      el.innerHTML = `<div class="adm-center">
        <p class="eyebrow">Admin</p>
        <h1 class="display">${T('Welcome back', 'Willkommen zurück')}</h1>
        ${msg ? `<p class="adm-error">${msg}</p>` : ''}
        <a class="btn btn-primary" href="/auth">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
          ${T('Sign in with GitHub', 'Mit GitHub anmelden')}
        </a></div>`;
      return;
    }
    el.innerHTML = `
      <div class="adm-bar">
        <div><p class="eyebrow">Admin</p><h1 class="display">${T('Your photos', 'Deine Fotos')}</h1></div>
        <div class="adm-user">${user ? `<img src="${esc(user.avatar_url)}" alt=""><span>${esc(user.login)}</span>` : ''}
          <a href="/" target="_blank">${T('View site', 'Website')}</a><button class="link" data-act="signout">${T('Sign out', 'Abmelden')}</button></div>
      </div>
      <div class="adm-status" hidden></div>
      <section class="adm-upload">
        <label class="drop">
          <input type="file" multiple accept=".jpg,.jpeg,.png,.webp,.tif,.tiff,.avif,image/jpeg,image/png,image/webp,image/tiff,image/avif">
          <span class="drop-title display">${T('Drop photos here', 'Fotos hierher ziehen')}</span>
          <span class="eyebrow">${T('or click to choose · drop a folder to create an album', 'oder klicken zum Auswählen · Ordner ablegen erstellt ein Album')}</span>
        </label>
        <div class="queue" hidden></div>
      </section>
      <section class="adm-albums"></section>`;
    el.querySelector('[data-act="signout"]').onclick = signOut;
    el.querySelector('.drop input').onchange = (e) => { addFiles([...e.target.files].map((file) => ({ file }))); e.target.value = ''; };
    renderQueue();
    renderAlbums();
  }

  // ---------- Upload queue ----------
  function addFiles(list) {
    const ok = list.filter((x) => ACCEPT.test(x.file.name));
    const skipped = list.length - ok.length;
    for (const x of ok) queue.push({ ...x, url: URL.createObjectURL(x.file), progress: 0 });
    if (skipped) status(T(`${skipped} file(s) skipped — only JPG, PNG, WebP, TIFF and AVIF are supported (export HEIC as JPG).`, `${skipped} Datei(en) übersprungen — nur JPG, PNG, WebP, TIFF und AVIF (HEIC bitte als JPG exportieren).`), 'warn');
    renderQueue();
  }

  function renderQueue() {
    const q = el.querySelector('.queue');
    if (!q) return;
    q.hidden = !queue.length;
    if (!queue.length) return;
    const names = albums().map((a) => a.folder);
    const needsAlbum = queue.some((x) => !x.album);
    const total = queue.reduce((s, x) => s + x.file.size, 0);
    const prev = q.querySelector('select')?.value;
    const prevNew = q.querySelector('.new-album')?.value;
    q.innerHTML = `
      <div class="queue-list">${queue.map((x, i) => `
        <figure class="q-item">
          <img src="${x.url}" alt="">
          <button class="q-remove" data-i="${i}" aria-label="Remove" ${busy ? 'disabled' : ''}>×</button>
          ${x.album ? `<span class="q-album">${esc(x.album)}</span>` : ''}
          <div class="q-bar"><span style="width:${Math.round(x.progress * 100)}%"></span></div>
        </figure>`).join('')}</div>
      <div class="queue-actions">
        <p class="eyebrow">${queue.length} ${T(queue.length === 1 ? 'photo' : 'photos', queue.length === 1 ? 'Foto' : 'Fotos')} · ${fmtSize(total)}</p>
        ${needsAlbum ? `<label class="field"><span class="eyebrow">${T('Album', 'Album')}</span>
          <select ${busy ? 'disabled' : ''}>
            ${names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
            <option value="__new">${esc(L('+ New album…', '+ Neues Album …'))}</option>
          </select></label>
          <input class="new-album" placeholder="${esc(L('Album name, e.g. Iceland 2026', 'Albumname, z. B. Island 2026'))}" ${busy ? 'disabled' : ''}>` : ''}
        <div class="queue-buttons">
          <button class="btn" data-act="clear" ${busy ? 'disabled' : ''}>${T('Clear', 'Leeren')}</button>
          <button class="btn btn-primary" data-act="upload" ${busy ? 'disabled' : ''}>${busy ? `<span class="spin"></span>${T('Uploading…', 'Lade hoch …')}` : T('Upload', 'Hochladen')}</button>
        </div>
      </div>`;
    const sel = q.querySelector('select');
    const input = q.querySelector('.new-album');
    if (sel) {
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
      else if (!names.length) sel.value = '__new';
      if (prevNew) input.value = prevNew;
      const sync = () => { input.hidden = sel.value !== '__new'; };
      sel.onchange = () => { sync(); if (!input.hidden) input.focus(); };
      sync();
    }
    q.querySelectorAll('.q-remove').forEach((b) => b.onclick = () => { URL.revokeObjectURL(queue[b.dataset.i].url); queue.splice(+b.dataset.i, 1); renderQueue(); });
    q.querySelector('[data-act="clear"]').onclick = () => { queue.forEach((x) => URL.revokeObjectURL(x.url)); queue = []; renderQueue(); };
    q.querySelector('[data-act="upload"]').onclick = upload;
  }

  async function upload() {
    const sel = el.querySelector('.queue select');
    let target = null;
    if (sel) {
      target = cleanName(sel.value === '__new' ? el.querySelector('.new-album').value : sel.value);
      if (!target) { status(T('Please enter an album name.', 'Bitte gib einen Albumnamen ein.'), 'warn'); el.querySelector('.new-album')?.focus(); return; }
    }
    busy = true;
    renderQueue();
    try {
      const taken = new Set(files.map((f) => f.path.toLowerCase()));
      const entries = [];
      const items = [...queue];
      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const x = items[next++];
          const album = cleanName(x.album || target);
          let name = cleanFile(x.file.name), n = 2;
          const [, base, ext] = name.match(/^(.*?)(\.[^.]+)?$/);
          while (taken.has(`photos/${album}/${name}`.toLowerCase())) name = `${base}-${n++}${ext || ''}`;
          const path = `photos/${album}/${name}`;
          taken.add(path.toLowerCase());
          const sha = await uploadBlob(await readAsBase64(x.file), (p) => { x.progress = p * 0.98; updateBars(); });
          x.progress = 1; updateBars();
          entries.push({ path, mode: '100644', type: 'blob', sha });
          localPreviews.set(path.slice('photos/'.length), x.url);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      const albumsTouched = [...new Set(entries.map((e) => e.path.split('/')[1]))];
      await commit(`Add ${entries.length} photo${entries.length === 1 ? '' : 's'} to ${albumsTouched.join(', ')}`, entries);
      albumsTouched.forEach((a) => open.add(a));
      queue = [];
    } catch (err) {
      status(esc(err.message), 'error', true);
    } finally {
      busy = false;
      renderQueue();
      renderAlbums();
    }
  }

  function updateBars() {
    el.querySelectorAll('.q-item .q-bar span').forEach((s, i) => { if (queue[i]) s.style.width = `${Math.round(queue[i].progress * 100)}%`; });
  }

  // Drag & drop anywhere on the page (files and folders)
  async function collect(dt) {
    const out = [];
    const items = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!items.length) return [...dt.files].map((file) => ({ file }));
    const readAll = (reader) => new Promise((res) => {
      const all = [];
      const step = () => reader.readEntries((batch) => { if (!batch.length) res(all); else { all.push(...batch); step(); } }, () => res(all));
      step();
    });
    const walk = async (entry, album) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
        if (file && !file.name.startsWith('.')) out.push({ file, album });
      } else if (entry.isDirectory) {
        for (const child of await readAll(entry.createReader())) await walk(child, album || entry.name);
      }
    };
    for (const entry of items) await walk(entry, null);
    return out;
  }
  let dragDepth = 0;
  addEventListener('dragenter', (e) => { if (token && !busy && e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
  addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  addEventListener('dragover', (e) => { if (token) e.preventDefault(); });
  addEventListener('drop', async (e) => {
    if (!token) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    if (!busy) addFiles(await collect(e.dataTransfer));
  });

  // ---------- Albums ----------
  function thumb(p) {
    const src = index[p.src]?.thumb || localPreviews.get(p.src);
    return src
      ? `<img src="${esc(src)}" alt="" loading="lazy">`
      : `<span class="pending">${T('processing…', 'wird verarbeitet …')}</span>`;
  }

  function renderAlbums() {
    const box = el.querySelector('.adm-albums');
    if (!box) return;
    const list = albums();
    box.innerHTML = `<div class="adm-albums-head"><h2 class="display">${T('Albums', 'Alben')}</h2><p class="eyebrow">${files.filter((f) => ACCEPT.test(f.path)).length} ${T('photos', 'Fotos')}</p></div>
      ${list.length ? '' : `<p class="muted">${T('No albums yet — drop some photos above to start.', 'Noch keine Alben — zieh oben Fotos hinein, um zu starten.')}</p>`}
      ${list.map((a) => `
        <details class="adm-album" data-folder="${esc(a.folder)}" ${open.has(a.folder) ? 'open' : ''}>
          <summary><span class="display">${esc(a.folder)}</span><span class="eyebrow">${a.photos.length} ${T('photos', 'Fotos')}</span></summary>
          <div class="adm-album-actions">
            <button class="btn btn-small" data-act="edit">${T('Edit title & text', 'Titel & Text bearbeiten')}</button>
            <button class="btn btn-small btn-danger" data-act="delete-album">${T('Delete album', 'Album löschen')}</button>
          </div>
          <div class="adm-edit" hidden></div>
          <div class="adm-grid">${a.photos.map((p) => `
            <figure class="adm-photo" data-path="${esc(p.path)}" data-src="${esc(p.src)}">
              ${thumb(p)}
              <figcaption>${esc(p.name)}</figcaption>
              <div class="adm-photo-actions">
                <button data-act="cover" title="${esc(L('Use as album cover', 'Als Albumcover verwenden'))}">◩</button>
                <button data-act="hero" class="${siteHero === p.src ? 'on' : ''}" title="${esc(L('Use as homepage hero', 'Als Titelbild der Startseite'))}">★</button>
                <button data-act="delete" title="${esc(L('Delete photo', 'Foto löschen'))}">✕</button>
              </div>
            </figure>`).join('')}</div>
        </details>`).join('')}`;

    box.querySelectorAll('.adm-album').forEach((d) => {
      d.addEventListener('toggle', () => d.open ? open.add(d.dataset.folder) : open.delete(d.dataset.folder));
    });
    box.onclick = onAlbumClick;
  }

  async function guarded(fn) {
    if (busy) return;
    busy = true;
    document.body.classList.add('adm-busy');
    try { await fn(); } catch (err) { status(esc(err.message), 'error', true); } finally {
      busy = false;
      document.body.classList.remove('adm-busy');
      renderQueue();
      renderAlbums();
    }
  }

  async function onAlbumClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const folder = btn.closest('.adm-album').dataset.folder;
    const photo = btn.closest('.adm-photo');
    const act = btn.dataset.act;

    if (act === 'delete' && photo) {
      if (!confirm(L(`Delete "${photo.dataset.src}"?`, `"${photo.dataset.src}" löschen?`))) return;
      guarded(() => commit(`Delete ${photo.dataset.src}`, [{ path: photo.dataset.path, mode: '100644', type: 'blob', sha: null }]));
    }
    if (act === 'cover' && photo) {
      guarded(async () => {
        const conf = await readJson(`photos/${folder}/_album.json`);
        conf.cover = photo.dataset.src.split('/')[1];
        await commit(`Set cover of ${folder}`, [{ path: `photos/${folder}/_album.json`, mode: '100644', type: 'blob', content: `${JSON.stringify(conf, null, 2)}\n` }]);
        status(T('Album cover updated.', 'Albumcover aktualisiert.'), 'ok');
      });
    }
    if (act === 'hero' && photo) {
      guarded(async () => {
        const site = JSON.parse(await readRepoFile('site.json') || '{}');
        site.hero = siteHero === photo.dataset.src ? '' : photo.dataset.src;
        await commit('Update homepage hero image', [{ path: 'site.json', mode: '100644', type: 'blob', content: `${JSON.stringify(site, null, 2)}\n` }]);
        siteHero = site.hero;
      });
    }
    if (act === 'delete-album') {
      const a = albums().find((x) => x.folder === folder);
      if (!confirm(L(`Delete the album "${folder}" with all ${a.photos.length} photos? This cannot be undone here.`, `Das Album "${folder}" mit allen ${a.photos.length} Fotos löschen?`))) return;
      const entries = files.filter((f) => f.path.startsWith(`photos/${folder}/`)).map((f) => ({ path: f.path, mode: '100644', type: 'blob', sha: null }));
      guarded(() => commit(`Delete album ${folder}`, entries));
    }
    if (act === 'edit') {
      const box = btn.closest('.adm-album').querySelector('.adm-edit');
      if (!box.hidden) { box.hidden = true; return; }
      box.hidden = false;
      box.innerHTML = `<span class="spin"></span>`;
      const conf = await readJson(`photos/${folder}/_album.json`);
      const v = (o, k) => esc(o?.[k] || '');
      box.innerHTML = `
        <label class="field"><span class="eyebrow">${T('Folder name', 'Ordnername')}</span><input name="folder" value="${esc(folder)}"></label>
        <div class="field-row">
          <label class="field"><span class="eyebrow">${T('Title (English)', 'Titel (Englisch)')}</span><input name="ten" value="${v(conf.title, 'en')}" placeholder="${esc(folder)}"></label>
          <label class="field"><span class="eyebrow">${T('Title (German)', 'Titel (Deutsch)')}</span><input name="tde" value="${v(conf.title, 'de')}" placeholder="${esc(folder)}"></label>
        </div>
        <div class="field-row">
          <label class="field"><span class="eyebrow">${T('Description (English)', 'Beschreibung (Englisch)')}</span><textarea name="den" rows="3">${v(conf.description, 'en')}</textarea></label>
          <label class="field"><span class="eyebrow">${T('Description (German)', 'Beschreibung (Deutsch)')}</span><textarea name="dde" rows="3">${v(conf.description, 'de')}</textarea></label>
        </div>
        <div class="queue-buttons"><button class="btn" data-edit="cancel">${T('Cancel', 'Abbrechen')}</button><button class="btn btn-primary" data-edit="save">${T('Save', 'Speichern')}</button></div>`;
      box.querySelector('[data-edit="cancel"]').onclick = () => { box.hidden = true; };
      box.querySelector('[data-edit="save"]').onclick = () => guarded(async () => {
        const val = (n) => box.querySelector(`[name="${n}"]`).value.trim();
        const newFolder = cleanName(val('folder')) || folder;
        const next = { ...conf };
        next.title = val('ten') || val('tde') ? { en: val('ten') || val('tde'), de: val('tde') || val('ten') } : undefined;
        next.description = val('den') || val('dde') ? { en: val('den') || val('dde'), de: val('dde') || val('den') } : undefined;
        const entries = [];
        if (newFolder !== folder) {
          if (albums().some((a) => a.folder.toLowerCase() === newFolder.toLowerCase() && a.folder !== folder)) {
            throw new Error(L('An album with that name already exists.', 'Ein Album mit diesem Namen existiert bereits.'));
          }
          for (const f of files.filter((x) => x.path.startsWith(`photos/${folder}/`) && !x.path.endsWith('/_album.json'))) {
            entries.push({ path: f.path.replace(`photos/${folder}/`, `photos/${newFolder}/`), mode: '100644', type: 'blob', sha: f.sha });
            entries.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
          }
          if (files.some((x) => x.path === `photos/${folder}/_album.json`)) entries.push({ path: `photos/${folder}/_album.json`, mode: '100644', type: 'blob', sha: null });
          if (siteHero.startsWith(`${folder}/`)) {
            const site = JSON.parse(await readRepoFile('site.json') || '{}');
            site.hero = siteHero.replace(`${folder}/`, `${newFolder}/`);
            entries.push({ path: 'site.json', mode: '100644', type: 'blob', content: `${JSON.stringify(site, null, 2)}\n` });
            siteHero = site.hero;
          }
          for (const [k, v2] of Object.entries(index)) if (k.startsWith(`${folder}/`)) index[k.replace(`${folder}/`, `${newFolder}/`)] = v2;
          open.delete(folder); open.add(newFolder);
        }
        entries.push({ path: `photos/${newFolder}/_album.json`, mode: '100644', type: 'blob', content: `${JSON.stringify(next, null, 2)}\n` });
        await commit(newFolder !== folder ? `Rename album ${folder} → ${newFolder}` : `Update album ${folder}`, entries);
      });
    }
  }

  // ---------- Start ----------
  document.addEventListener('langchange', () => { if (token) { renderQueue(); renderAlbums(); } });

  async function start() {
    render();
    if (!token || !cfg.repo) return;
    try {
      const [u, repo] = await Promise.all([gh('/user'), gh(`/repos/${cfg.repo}`)]);
      user = u;
      if (!repo.permissions?.push) {
        ss.set('gh_token', null); token = null;
        el.innerHTML = `<div class="adm-center"><h1 class="display">${T('No access', 'Kein Zugriff')}</h1><p>${T(`The account ${u.login} can't edit ${cfg.repo}.`, `Das Konto ${u.login} darf ${cfg.repo} nicht bearbeiten.`)}</p></div>`;
        return;
      }
      const [, idx, site] = await Promise.all([
        loadTree(),
        fetch('/data/photos.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
        readRepoFile('site.json').then((s) => JSON.parse(s || '{}')).catch(() => ({})),
      ]);
      index = idx;
      siteHero = site.hero || '';
      render();
    } catch (err) {
      if (token) status(esc(err.message), 'error', true);
    }
  }
  start();
})();
