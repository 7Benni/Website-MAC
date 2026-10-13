// Turns the photos/ folder into a static website in dist/.
// Every subfolder of photos/ is an album. Images are resized, EXIF is read,
// and results are cached in .cache/ so unchanged photos are never re-processed.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import exifr from 'exifr';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHOTOS = path.resolve(process.env.PHOTOS_DIR || path.join(ROOT, 'photos'));
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, '.cache', 'images');
const LONG_EDGES = [800, 1600, 2560];
const IMAGE_EXT = /\.(jpe?g|png|webp|tiff?|avif)$/i;

const exists = (p) => fs.access(p).then(() => true, () => false);

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'album';
}

function formatExif(e) {
  if (!e) return {};
  const make = (e.Make || '').trim();
  let model = (e.Model || '').trim();
  if (make && model && !model.toLowerCase().startsWith(make.split(' ')[0].toLowerCase())) {
    model = `${make.split(' ')[0]} ${model}`;
  }
  const t = e.ExposureTime;
  const parts = [
    model,
    e.FocalLength && `${Math.round(e.FocalLength)}mm`,
    e.FNumber && `ƒ/${Math.round(e.FNumber * 10) / 10}`,
    t && (t < 1 ? `1/${Math.round(1 / t)}s` : `${Math.round(t * 10) / 10}s`),
    e.ISO && `ISO ${e.ISO}`,
  ].filter(Boolean);
  const date = e.DateTimeOriginal || e.CreateDate;
  return {
    line: parts.join(' · '),
    lens: (e.LensModel || '').trim(),
    date: date instanceof Date && !isNaN(date) ? date.toISOString() : null,
  };
}

async function processPhoto(file) {
  const buf = await fs.readFile(file);
  const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
  const metaFile = path.join(CACHE, `${hash}.json`);

  if (await exists(metaFile)) {
    const meta = JSON.parse(await fs.readFile(metaFile, 'utf8'));
    const all = await Promise.all(meta.sizes.map((s) => exists(path.join(CACHE, s.file))));
    if (all.every(Boolean)) return meta;
  }

  const info = await sharp(buf, { failOn: 'none' }).metadata();
  const rotated = (info.orientation || 1) >= 5;
  const width = rotated ? info.height : info.width;
  const height = rotated ? info.width : info.height;
  const longEdge = Math.max(width, height);

  const edges = LONG_EDGES.filter((e) => e < longEdge);
  if (edges.length < LONG_EDGES.length) edges.push(longEdge);

  const sizes = [];
  for (const edge of edges) {
    const out = `${hash}-${edge}.webp`;
    const res = await sharp(buf, { failOn: 'none' })
      .rotate()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 84 })
      .toFile(path.join(CACHE, out)); // metadata (incl. GPS) is stripped
    sizes.push({ w: res.width, h: res.height, file: out });
  }

  const px = await sharp(buf, { failOn: 'none' }).resize(1, 1, { fit: 'cover' }).removeAlpha().raw().toBuffer();
  const color = `rgb(${px[0]},${px[1]},${px[2]})`;

  let exif = {};
  try {
    exif = formatExif(await exifr.parse(buf, [
      'Make', 'Model', 'LensModel', 'FNumber', 'ExposureTime', 'ISO', 'FocalLength', 'DateTimeOriginal', 'CreateDate',
    ]));
  } catch { /* no EXIF */ }

  const meta = { hash, w: width, h: height, color, exif, sizes };
  await fs.writeFile(metaFile, JSON.stringify(meta));
  return meta;
}

async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }));
  return results;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

function repoConfig(site) {
  if (site.admin?.repo) return { repo: site.admin.repo, branch: site.admin.branch || 'main' };
  let url = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : '';
  if (!url) {
    try { url = execSync('git remote get-url origin', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* no git */ }
  }
  const m = url.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/);
  let branch = process.env.GITHUB_REF_NAME;
  if (!branch) {
    try { branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* no git */ }
  }
  return { repo: m ? m[1] : '', branch: branch && branch !== 'HEAD' ? branch : 'main' };
}

async function build() {
  const started = Date.now();
  const tpl = await import(`../src/templates.mjs?t=${started}`);
  tpl.setBase(process.env.BASE_PATH);
  const site = await readJson(path.join(ROOT, 'site.json'), {});
  await fs.mkdir(CACHE, { recursive: true });
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(path.join(DIST, 'img'), { recursive: true });

  // Collect files: photos/<Album>/<file> and loose photos/<file>
  const entries = [];
  const albumDefs = [];
  for (const dirent of await fs.readdir(PHOTOS, { withFileTypes: true }).catch(() => [])) {
    if (dirent.name.startsWith('.') || dirent.name.startsWith('_')) continue;
    if (dirent.isDirectory()) {
      const dir = path.join(PHOTOS, dirent.name);
      const conf = await readJson(path.join(dir, '_album.json'), {});
      albumDefs.push({ folder: dirent.name, slug: slugify(dirent.name), conf });
      for (const f of (await fs.readdir(dir)).sort()) {
        if (IMAGE_EXT.test(f) && !f.startsWith('.')) entries.push({ file: path.join(dir, f), src: `${dirent.name}/${f}`, folder: dirent.name, name: f });
      }
    } else if (IMAGE_EXT.test(dirent.name)) {
      entries.push({ file: path.join(PHOTOS, dirent.name), src: dirent.name, folder: null, name: dirent.name });
    }
  }

  // Unique slugs
  const seen = new Set();
  for (const a of albumDefs) {
    let s = a.slug, n = 2;
    while (seen.has(s)) s = `${a.slug}-${n++}`;
    a.slug = s; seen.add(s);
  }

  let done = 0;
  const photos = await pool(entries, 4, async (entry) => {
    try {
      const meta = await processPhoto(entry.file);
      done++;
      if (process.stdout.isTTY) process.stdout.write(`\r  processing photos ${done}/${entries.length}`);
      return { ...entry, ...meta };
    } catch (err) {
      console.warn(`\n  ! skipped ${entry.src}: ${err.message}`);
      return null;
    }
  });
  if (process.stdout.isTTY && entries.length) process.stdout.write('\n');
  const valid = photos.filter(Boolean);

  // Newest first (capture date, then filename)
  const byDate = (a, b) => (b.exif.date || '').localeCompare(a.exif.date || '') || a.name.localeCompare(b.name);

  const albums = albumDefs.map((a) => {
    const list = valid.filter((p) => p.folder === a.folder).sort(byDate);
    const cover = list.find((p) => p.name === a.conf.cover) || list.find((p) => /^cover\./i.test(p.name)) || list[0];
    return {
      slug: a.slug,
      folder: a.folder,
      title: a.conf.title || { en: a.folder, de: a.folder },
      description: a.conf.description || null,
      order: a.conf.order,
      photos: list,
      cover,
      newest: list[0]?.exif.date || '',
    };
  }).filter((a) => a.photos.length)
    .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || b.newest.localeCompare(a.newest) || a.folder.localeCompare(b.folder));

  const albumBySlug = new Map(albums.map((a) => [a.folder, a]));
  for (const p of valid) p.album = p.folder ? albumBySlug.get(p.folder) : null;

  // Copy resized images into dist
  const used = new Set();
  for (const p of valid) {
    for (const s of p.sizes) {
      if (used.has(s.file)) continue;
      used.add(s.file);
      await fs.copyFile(path.join(CACHE, s.file), path.join(DIST, 'img', s.file));
    }
  }

  // Drop cache entries for photos that no longer exist
  const liveHashes = new Set(valid.map((p) => p.hash));
  for (const f of await fs.readdir(CACHE)) {
    if (!liveHashes.has(f.slice(0, 12))) await fs.rm(path.join(CACHE, f), { force: true });
  }

  const latest = [...valid].sort(byDate).slice(0, site.latestCount || 30);
  const hero = valid.find((p) => p.src === site.hero) || latest.find((p) => p.w > p.h * 1.2) || latest[0];
  const aboutPhoto = valid.find((p) => p.src === site.about?.photo) || null;

  const ctx = { site, albums, latest, hero, aboutPhoto, year: new Date().getFullYear() };
  const write = async (rel, html) => {
    const out = path.join(DIST, rel);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, html);
  };

  await write('index.html', tpl.home(ctx));
  for (const [i, album] of albums.entries()) {
    await write(`album/${album.slug}/index.html`, tpl.album(ctx, album, albums[i - 1], albums[i + 1]));
  }
  await write('about/index.html', tpl.about(ctx));
  if (site.imprint?.en || site.imprint?.de) await write('imprint/index.html', tpl.imprint(ctx));
  await write('admin/index.html', tpl.admin(ctx, repoConfig(site)));
  await write('404.html', tpl.notFound(ctx));

  // Data for the admin page
  const index = {};
  for (const p of valid) index[p.src] = { thumb: `/img/${p.sizes[0].file}`, w: p.w, h: p.h };
  await write('data/photos.json', JSON.stringify(index));
  await write('version.json', JSON.stringify({ commit: process.env.GITHUB_SHA || null, built: new Date().toISOString() }));

  // Static assets
  await fs.cp(path.join(ROOT, 'src', 'assets'), path.join(DIST, 'assets'), { recursive: true });
  const fonts = path.join(DIST, 'fonts');
  await fs.mkdir(fonts, { recursive: true });
  const nm = path.join(ROOT, 'node_modules');
  for (const [from, to] of [
    ['@fontsource/cormorant-garamond/files/cormorant-garamond-latin-400-normal.woff2', 'cormorant-400.woff2'],
    ['@fontsource/cormorant-garamond/files/cormorant-garamond-latin-400-italic.woff2', 'cormorant-400-italic.woff2'],
    ['@fontsource/cormorant-garamond/files/cormorant-garamond-latin-500-normal.woff2', 'cormorant-500.woff2'],
    ['@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', 'inter.woff2'],
  ]) await fs.copyFile(path.join(nm, from), path.join(fonts, to));

  console.log(`  built ${valid.length} photos in ${albums.length} albums (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build().catch((err) => { console.error(err); process.exit(1); });
}

export { build };
