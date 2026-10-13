// Admin: sign in with a GitHub access key, drag & drop photos, manage albums.
// Every change is a commit to the GitHub repository; GitHub Actions then rebuilds the site.
(() => {
  const cfg = window.ADMIN_CONFIG || {};
  const el = document.getElementById('admin');
  const API = 'https://api.github.com';
  const ACCEPT = /\.(jpe?g|png|webp|tiff?|avif)$/i;
  const T = (en, de) => en === de ? esc(en) : `<span lang="en">${esc(en)}</span><span lang="de">${esc(de)}</span>`;
  const L = (en, de) => (document.documentElement.dataset.lang === 'de' ? de : en);
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  const BASE = cfg.base || '';
  const MAX_EDGE = 3000; // photos are shrunk to this long edge before upload
  // The key is remembered on this device, so you only paste it once.
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  let loginError = '';
  let token = store.get('gh_token');
  let user = null;
  let files = [];      // [{path, sha}] under photos/
  let index = {};      // published thumbnails: { "Album/file.jpg": { thumb } }
  let heroes = [];     // homepage slideshow, from site.json "hero"
  let siteConf = {};   // site.json as in the repository
  let confs = new Map(); // album folder -> _album.json
  const blobCache = new Map(); // blob sha -> parsed JSON
  let sorting = null;  // folder being reordered, '__albums' for album order, or null
  const heroArr = (h) => [].concat(h || []).filter(Boolean);
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
    if (res.status === 401) { signOut('invalid'); throw new Error(L('Your access key is invalid or expired.', 'Dein Zugangsschlüssel ist ungültig oder abgelaufen.')); }
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

  // Shrink big photos to MAX_EDGE and remove GPS location (the repository is public).
  // Camera info (EXIF) is kept. Returns { blob, name }.
  async function prepare(file) {
    const X = window.ExifClean;
    const isJpeg = /\.jpe?g$/i.test(file.name);
    if (!isJpeg && !/\.(png|webp)$/i.test(file.name)) return { blob: file, name: file.name };
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return { blob: file, name: file.name }; }
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const bytes = isJpeg ? new Uint8Array(await file.arrayBuffer()) : null;
    const pos = bytes && X.find(bytes);
    const cleanSeg = (opts) => { try { return X.clean(bytes.subarray(pos.start, pos.end), opts); } catch { return { seg: null, hadGps: true }; } };

    if (scale === 1) {
      bmp.close();
      if (!pos) return { blob: file, name: file.name };
      const { seg, hadGps } = cleanSeg();
      return hadGps ? { blob: new Blob([X.replace(bytes, pos, seg)], { type: 'image/jpeg' }), name: file.name } : { blob: file, name: file.name };
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
    if (!out) return { blob: file, name: file.name };
    const seg = pos ? cleanSeg({ resetOrientation: true }).seg : null;
    const jpeg = X.insert(new Uint8Array(await out.arrayBuffer()), seg);
    return { blob: new Blob([jpeg], { type: 'image/jpeg' }), name: file.name.replace(/\.[^.]+$/, '.jpg') };
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
    const site = tree.tree.find((n) => n.path === 'site.json');
    const readBlob = async (blobSha) => {
      if (!blobCache.has(blobSha)) {
        const b = await gh(`/repos/${cfg.repo}/git/blobs/${blobSha}`);
        const text = new TextDecoder().decode(Uint8Array.from(atob(b.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
        let data = {};
        try { data = JSON.parse(text); } catch { /* invalid JSON */ }
        blobCache.set(blobSha, data);
      }
      return blobCache.get(blobSha);
    };
    const albumFiles = files.filter((f) => f.path.split('/').length === 3 && f.path.endsWith('/_album.json'));
    const [siteData, ...albumData] = await Promise.all([site ? readBlob(site.sha) : {}, ...albumFiles.map((f) => readBlob(f.sha))]);
    siteConf = siteData;
    heroes = heroArr(siteConf.hero);
    confs = new Map(albumFiles.map((f, i) => [f.path.split('/')[1], albumData[i]]));
  }


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
    // Same order as the website: custom order first, the rest newest first.
    const date = (src) => index[src]?.date || '';
    const albumRank = new Map((Array.isArray(siteConf.albumOrder) ? siteConf.albumOrder : []).map((f, i) => [f, i]));
    const list = [...map.values()];
    for (const a of list) {
      a.conf = confs.get(a.folder) || {};
      const rank = new Map((Array.isArray(a.conf.photos) ? a.conf.photos : []).map((n, i) => [n, i]));
      a.photos.sort((x, y) => (rank.get(x.name) ?? 1e9) - (rank.get(y.name) ?? 1e9) || date(y.src).localeCompare(date(x.src)) || x.name.localeCompare(y.name));
      a.newest = a.photos.map((p) => date(p.src)).sort().pop() || '';
    }
    return list.sort((a, b) => (albumRank.get(a.folder) ?? 1e9) - (albumRank.get(b.folder) ?? 1e9)
      || (a.conf.order ?? 1e9) - (b.conf.order ?? 1e9) || b.newest.localeCompare(a.newest) || a.folder.localeCompare(b.folder));
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
        const v = await fetch(`${BASE}/version.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => r.json());
        if (v.commit === sha) {
          index = await fetch(`${BASE}/data/photos.json?t=${Date.now()}`, { cache: 'no-store' }).then((r) => r.json()).catch(() => index);
          renderAlbums();
          status(`${T('Live! Your changes are on the website.', 'Online! Deine Änderungen sind auf der Website.')} <a href="${BASE}/" target="_blank">${T('View site →', 'Website ansehen →')}</a>`, 'ok', true);
          return;
        }
      } catch { /* not deployed yet */ }
      if (Date.now() - started < 8 * 60e3) setTimeout(tick, 6000);
      else status(T('Saved to GitHub. The rebuild is taking longer than usual — check the “Actions” tab on GitHub if it doesn’t show up.', 'Auf GitHub gespeichert. Der Build dauert länger als üblich — prüfe den Tab „Actions“ auf GitHub, falls nichts erscheint.'), 'info', true);
    };
    setTimeout(tick, 15000);
  }

  // ---------- Views ----------
  function signOut(reason = '') { store.set('gh_token', null); token = null; user = null; loginError = reason; render(); }

  function render() {
    if (!cfg.repo) {
      el.innerHTML = `<div class="adm-center"><h1 class="display">Admin</h1>
        <p>${T('This site is not connected to a GitHub repository yet. Follow the setup steps in README.md.', 'Diese Website ist noch nicht mit einem GitHub-Repository verbunden. Folge den Schritten in README.md.')}</p></div>`;
      return;
    }
    if (!token) {
      const msg = {
        invalid: T('That key didn’t work — it may be mistyped or expired.', 'Dieser Schlüssel hat nicht funktioniert — vielleicht vertippt oder abgelaufen.'),
        noaccess: T(`That key has no write access to ${cfg.repo}.`, `Dieser Schlüssel hat keinen Schreibzugriff auf ${cfg.repo}.`),
      }[loginError] || '';
      const [owner, repoName] = cfg.repo.split('/');
      const newKey = `https://github.com/settings/personal-access-tokens/new?name=${encodeURIComponent('Portfolio admin')}&description=${encodeURIComponent('Upload photos to my website')}&target_name=${encodeURIComponent(owner)}&expires_in=366&contents=write`;
      el.innerHTML = `<div class="adm-center adm-login">
        <p class="eyebrow">Admin</p>
        <h1 class="display">${T('Welcome back', 'Willkommen zurück')}</h1>
        <p>${T('Paste your GitHub access key to sign in. This device remembers it.', 'Füge deinen GitHub-Zugangsschlüssel ein. Dieses Gerät merkt ihn sich.')}</p>
        ${msg ? `<p class="adm-error">${msg}</p>` : ''}
        <form class="adm-key">
          <input type="password" name="key" placeholder="github_pat_…" autocomplete="off" spellcheck="false" required>
          <button class="btn btn-primary">${T('Sign in', 'Anmelden')}</button>
        </form>
        <details class="adm-help">
          <summary>${T('No key yet? Create one (2 minutes)', 'Noch kein Schlüssel? So erstellst du einen (2 Minuten)')}</summary>
          <ol>
            <li><a href="${newKey}" target="_blank" rel="noopener">${T('Open GitHub → new access key', 'GitHub öffnen → neuer Zugangsschlüssel')} ↗</a></li>
            <li>${T('Expiration: pick up to 1 year (you just paste a new key when it runs out).', 'Ablauf: bis zu 1 Jahr (danach einfach einen neuen Schlüssel einfügen).')}</li>
            <li>${T('Repository access: “Only select repositories” →', 'Repository-Zugriff: „Only select repositories“ →')} <b>${esc(repoName)}</b></li>
            <li>${T('Permissions → Repository permissions → Contents: “Read and write”', 'Permissions → Repository permissions → Contents: „Read and write“')}</li>
            <li>${T('Click “Generate token”, copy it and paste it above.', 'Auf „Generate token“ klicken, kopieren und oben einfügen.')}</li>
          </ol>
        </details></div>`;
      el.querySelector('.adm-key').onsubmit = (e) => {
        e.preventDefault();
        token = e.target.key.value.trim();
        store.set('gh_token', token);
        loginError = '';
        start();
      };
      return;
    }
    el.innerHTML = `
      <div class="adm-bar">
        <div><p class="eyebrow">Admin</p><h1 class="display">${T('Your photos', 'Deine Fotos')}</h1></div>
        <div class="adm-user">${user ? `<img src="${esc(user.avatar_url)}" alt=""><span>${esc(user.login)}</span>` : ''}
          <a href="${BASE}/" target="_blank">${T('View site', 'Website')}</a><button class="link" data-act="signout">${T('Sign out', 'Abmelden')}</button></div>
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
          const ready = await prepare(x.file);
          let name = cleanFile(ready.name), n = 2;
          const [, base, ext] = name.match(/^(.*?)(\.[^.]+)?$/);
          while (taken.has(`photos/${album}/${name}`.toLowerCase())) name = `${base}-${n++}${ext || ''}`;
          const path = `photos/${album}/${name}`;
          taken.add(path.toLowerCase());
          const sha = await uploadBlob(await readAsBase64(ready.blob), (p) => { x.progress = p * 0.98; updateBars(); });
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
    const src = index[p.src]?.thumb ? BASE + index[p.src].thumb : localPreviews.get(p.src);
    return src
      ? `<img src="${esc(src)}" alt="" loading="lazy">`
      : `<span class="pending">${T('processing…', 'wird verarbeitet …')}</span>`;
  }

  function renderAlbums() {
    const box = el.querySelector('.adm-albums');
    if (!box) return;
    const list = albums();
    const sortBar = (hint) => `<div class="adm-sortbar"><span>${hint}</span><span class="spacer"></span>
      <button class="btn btn-small" data-act="sort-cancel">${T('Cancel', 'Abbrechen')}</button>
      <button class="btn btn-small btn-primary" data-act="sort-save">${T('Save order', 'Reihenfolge speichern')}</button></div>`;
    const sortingAlbums = sorting === '__albums';
    box.innerHTML = `<div class="adm-albums-head"><h2 class="display">${T('Albums', 'Alben')}</h2>
        <span class="adm-albums-meta"><span class="eyebrow">${files.filter((f) => ACCEPT.test(f.path)).length} ${T('photos', 'Fotos')}</span>
        ${list.length > 1 && !sorting ? `<button class="btn btn-small" data-act="sort-albums">⇅ ${T('Reorder albums', 'Alben sortieren')}</button>` : ''}</span></div>
      ${sortingAlbums ? sortBar(T('Drag the albums into the order you want.', 'Zieh die Alben in die gewünschte Reihenfolge.')) : ''}
      ${list.length ? '' : `<p class="muted">${T('No albums yet — drop some photos above to start.', 'Noch keine Alben — zieh oben Fotos hinein, um zu starten.')}</p>`}
      <div class="adm-album-list ${sortingAlbums ? 'is-sorting' : ''}">
      ${list.map((a) => {
        const sortingThis = sorting === a.folder;
        const isOpen = !sortingAlbums && (open.has(a.folder) || sortingThis);
        return `
        <details class="adm-album" data-folder="${esc(a.folder)}" ${isOpen ? 'open' : ''}>
          <summary>${sortingAlbums ? '<span class="handle" aria-hidden="true">⠿</span>' : ''}<span class="display">${esc(a.folder)}</span><span class="eyebrow">${a.photos.length} ${a.photos.length === 1 ? T('photo', 'Foto') : T('photos', 'Fotos')}</span></summary>
          ${sortingThis ? sortBar(T('Drag the photos into the order you want. The first one opens the album.', 'Zieh die Fotos in die gewünschte Reihenfolge. Das erste eröffnet das Album.')) : `
          <div class="adm-album-actions">
            ${a.photos.length > 1 && !sorting ? `<button class="btn btn-small" data-act="sort">⇅ ${T('Reorder photos', 'Reihenfolge ändern')}</button>` : ''}
            <button class="btn btn-small" data-act="edit">${T('Edit title & text', 'Titel & Text bearbeiten')}</button>
            <button class="btn btn-small btn-danger" data-act="delete-album">${T('Delete album', 'Album löschen')}</button>
          </div>
          <div class="adm-edit" hidden></div>`}
          <div class="adm-grid ${sortingThis ? 'is-sorting' : ''}">${a.photos.map((p, i) => `
            <figure class="adm-photo" data-path="${esc(p.path)}" data-src="${esc(p.src)}">
              ${thumb(p)}
              ${sortingThis ? `<span class="adm-pos">${i + 1}</span>` : ''}
              <figcaption>${esc(p.name)}</figcaption>
              ${sortingThis ? '' : `<div class="adm-photo-actions">
                <button data-act="cover" class="${a.conf.cover === p.name ? 'on' : ''}" title="${esc(L('Use as album cover', 'Als Albumcover verwenden'))}">◩</button>
                <button data-act="focus" title="${esc(L('Set focus point (how it is cropped)', 'Fokuspunkt setzen (Bildausschnitt)'))}">◎</button>
                <button data-act="hero" class="${heroes.includes(p.src) ? 'on' : ''}" title="${esc(L('Show in homepage slideshow', 'In der Startseiten-Diashow zeigen'))}">★</button>
                <button data-act="delete" title="${esc(L('Delete photo', 'Foto löschen'))}">✕</button>
              </div>`}
            </figure>`).join('')}</div>
        </details>`;
      }).join('')}
      </div>`;

    box.querySelectorAll('.adm-album').forEach((d) => {
      d.addEventListener('toggle', () => { if (!sorting) d.open ? open.add(d.dataset.folder) : open.delete(d.dataset.folder); });
    });
    if (sortingAlbums) {
      box.querySelectorAll('.adm-album summary').forEach((sm) => sm.addEventListener('click', (e) => e.preventDefault()));
      sortable(box.querySelector('.adm-album-list'), '.adm-album', 'y');
    } else if (sorting) {
      const grid = box.querySelector('.adm-grid.is-sorting');
      if (grid) sortable(grid, '.adm-photo', 'x', () => grid.querySelectorAll('.adm-pos').forEach((n, i) => { n.textContent = i + 1; }));
    }
    box.onclick = onAlbumClick;
  }

  // Drag to reorder (mouse and touch). axis 'x' for grids, 'y' for lists.
  function sortable(container, selector, axis, onMove = () => {}) {
    let item = null;
    container.addEventListener('pointerdown', (e) => {
      const target = e.target.closest(selector);
      if (!target || e.button > 0) return;
      e.preventDefault();
      item = target;
      item.classList.add('dragging');
      container.setPointerCapture(e.pointerId);
    });
    container.addEventListener('pointermove', (e) => {
      if (!item) return;
      if (e.clientY < 90) scrollBy(0, -14); else if (e.clientY > innerHeight - 90) scrollBy(0, 14);
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(selector);
      if (!over || over === item || !container.contains(over)) return;
      const r = over.getBoundingClientRect();
      const after = axis === 'y'
        ? e.clientY > r.top + r.height / 2
        : (e.clientY > r.bottom ? true : e.clientY < r.top ? false : e.clientX > r.left + r.width / 2);
      container.insertBefore(item, after ? over.nextSibling : over);
      onMove();
    });
    const end = () => { item?.classList.remove('dragging'); item = null; };
    container.addEventListener('pointerup', end);
    container.addEventListener('pointercancel', end);
  }

  // Focus point: tap the most important spot; crops (hero, album cover) keep it in view.
  async function openFocus(folder, src) {
    const img = index[src]?.thumb ? BASE + index[src].thumb : localPreviews.get(src);
    if (!img) { status(T('This photo is still being processed — try again in a minute.', 'Dieses Foto wird noch verarbeitet — versuch es in einer Minute nochmal.'), 'warn'); return; }
    const name = src.split('/')[1];
    const conf = structuredClone(confs.get(folder) || {});
    let [x, y] = conf.focus?.[name] || [50, 50];
    const modal = document.createElement('div');
    modal.className = 'adm-modal';
    modal.innerHTML = `<div class="adm-focus" role="dialog" aria-modal="true">
      <p class="eyebrow">${T('Focus point', 'Fokuspunkt')}</p>
      <h3 class="display">${T('Tap the most important part of the photo', 'Tippe auf das Wichtigste im Bild')}</h3>
      <div class="focus-stage"><img src="${esc(img)}" alt=""><span class="focus-dot"></span></div>
      <div class="focus-previews">
        <figure><div class="pv pv-phone"><img src="${esc(img)}" alt=""></div><figcaption class="eyebrow">${T('Phone', 'Handy')}</figcaption></figure>
        <figure><div class="pv pv-card"><img src="${esc(img)}" alt=""></div><figcaption class="eyebrow">${T('Album cover', 'Albumcover')}</figcaption></figure>
        <figure><div class="pv pv-wide"><img src="${esc(img)}" alt=""></div><figcaption class="eyebrow">${T('Desktop', 'Desktop')}</figcaption></figure>
      </div>
      <div class="queue-buttons"><button class="btn" data-f="reset">${T('Center', 'Mitte')}</button><span class="spacer"></span><button class="btn" data-f="cancel">${T('Cancel', 'Abbrechen')}</button><button class="btn btn-primary" data-f="save">${T('Save', 'Speichern')}</button></div>
    </div>`;
    document.body.appendChild(modal);
    const update = () => {
      modal.querySelector('.focus-dot').style.cssText = `left:${x}%;top:${y}%`;
      modal.querySelectorAll('.pv img').forEach((i) => { i.style.objectPosition = `${x}% ${y}%`; });
    };
    update();
    const stage = modal.querySelector('.focus-stage');
    const pick = (e) => {
      const r = stage.querySelector('img').getBoundingClientRect();
      x = Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
      y = Math.round(Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100)));
      update();
    };
    let dragging = false;
    stage.addEventListener('pointerdown', (e) => { dragging = true; stage.setPointerCapture(e.pointerId); pick(e); });
    stage.addEventListener('pointermove', (e) => dragging && pick(e));
    stage.addEventListener('pointerup', () => { dragging = false; });
    const close = () => modal.remove();
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('[data-f="cancel"]').onclick = close;
    modal.querySelector('[data-f="reset"]').onclick = () => { x = 50; y = 50; update(); };
    modal.querySelector('[data-f="save"]').onclick = () => {
      close();
      guarded(async () => {
        const fresh = structuredClone(confs.get(folder) || {});
        fresh.focus = { ...(fresh.focus || {}), [name]: [x, y] };
        await commit(`Set focus point of ${src}`, [{ path: `photos/${folder}/_album.json`, mode: '100644', type: 'blob', content: `${JSON.stringify(fresh, null, 2)}\n` }]);
      });
    };
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
    if (btn.dataset.act === 'sort-albums') { sorting = '__albums'; renderAlbums(); return; }
    const folder = btn.closest('.adm-album')?.dataset.folder;
    const photo = btn.closest('.adm-photo');
    const act = btn.dataset.act;

    if (act === 'delete' && photo) {
      if (!confirm(L(`Delete "${photo.dataset.src}"?`, `"${photo.dataset.src}" löschen?`))) return;
      guarded(() => commit(`Delete ${photo.dataset.src}`, [{ path: photo.dataset.path, mode: '100644', type: 'blob', sha: null }]));
    }
    if (act === 'cover' && photo) {
      guarded(async () => {
        const conf = structuredClone(confs.get(folder) || {});
        conf.cover = photo.dataset.src.split('/')[1];
        await commit(`Set cover of ${folder}`, [{ path: `photos/${folder}/_album.json`, mode: '100644', type: 'blob', content: `${JSON.stringify(conf, null, 2)}\n` }]);
        status(T('Album cover updated.', 'Albumcover aktualisiert.'), 'ok');
      });
    }
    if (act === 'hero' && photo) {
      guarded(async () => {
        const site = structuredClone(siteConf);
        const src = photo.dataset.src;
        const list = heroArr(site.hero);
        site.hero = list.includes(src) ? list.filter((x) => x !== src) : [...list, src];
        await commit('Update homepage slideshow', [{ path: 'site.json', mode: '100644', type: 'blob', content: `${JSON.stringify(site, null, 2)}\n` }]);
        heroes = site.hero;
        status(heroes.length
          ? T(`Homepage slideshow: ${heroes.length} photo${heroes.length === 1 ? '' : 's'}.`, `Startseiten-Diashow: ${heroes.length} Foto${heroes.length === 1 ? '' : 's'}.`)
          : T('No photo starred: the homepage shows your newest landscape photo.', 'Kein Foto markiert: Die Startseite zeigt dein neuestes Querformat-Foto.'), 'ok', true);
      });
    }
    if (act === 'focus' && photo) openFocus(folder, photo.dataset.src);
    if (act === 'sort') { sorting = folder; renderAlbums(); }
    if (act === 'sort-cancel') { sorting = null; renderAlbums(); }
    if (act === 'sort-save') {
      const target = sorting;
      if (target === '__albums') {
        const order = [...el.querySelectorAll('.adm-album')].map((d) => d.dataset.folder);
        sorting = null;
        guarded(async () => {
          const site = structuredClone(siteConf);
          site.albumOrder = order;
          await commit('Reorder albums', [{ path: 'site.json', mode: '100644', type: 'blob', content: `${JSON.stringify(site, null, 2)}\n` }]);
        });
      } else {
        const names = [...el.querySelectorAll('.adm-grid.is-sorting .adm-photo')].map((f) => f.dataset.src.split('/')[1]);
        sorting = null;
        guarded(async () => {
          const conf = structuredClone(confs.get(target) || {});
          conf.photos = names;
          await commit(`Reorder photos in ${target}`, [{ path: `photos/${target}/_album.json`, mode: '100644', type: 'blob', content: `${JSON.stringify(conf, null, 2)}\n` }]);
        });
      }
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
      const conf = structuredClone(confs.get(folder) || {});
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
          const inOrder = Array.isArray(siteConf.albumOrder) && siteConf.albumOrder.includes(folder);
          if (heroes.some((h) => h.startsWith(`${folder}/`)) || inOrder) {
            const site = structuredClone(siteConf);
            site.hero = heroArr(site.hero).map((h) => h.startsWith(`${folder}/`) ? h.replace(`${folder}/`, `${newFolder}/`) : h);
            if (inOrder) site.albumOrder = site.albumOrder.map((f) => f === folder ? newFolder : f);
            entries.push({ path: 'site.json', mode: '100644', type: 'blob', content: `${JSON.stringify(site, null, 2)}\n` });
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
      if (!repo.permissions?.push) { signOut('noaccess'); return; }
      const [, idx] = await Promise.all([
        loadTree(),
        fetch(`${BASE}/data/photos.json`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
      ]);
      index = idx;
      render();
    } catch (err) {
      if (err.status === 404 || err.status === 403) signOut('noaccess');
      else if (token) status(esc(err.message), 'error', true);
    }
  }
  start();
})();
