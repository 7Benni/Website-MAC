// Local preview: builds the site, serves it at http://localhost:3000
// and rebuilds automatically when photos, site.json or templates change.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

let building = false, again = false;
async function rebuild() {
  if (building) { again = true; return; }
  building = true;
  try {
    const { build } = await import(`./build.mjs?t=${Date.now()}`);
    await build();
  } catch (err) { console.error(err); }
  building = false;
  if (again) { again = false; rebuild(); }
}

await rebuild();

let timer;
const watch = (p) => fs.existsSync(p) && fs.watch(p, { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(rebuild, 400); });
watch(process.env.PHOTOS_DIR || path.join(ROOT, 'photos'));
watch(path.join(ROOT, 'src'));
watch(path.join(ROOT, 'site.json'));

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(DIST, p);
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': TYPES['.html'] }); return fs.createReadStream(path.join(DIST, '404.html')).pipe(res); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`\n  Preview: http://localhost:${PORT}\n  (changes in photos/ rebuild automatically — Ctrl+C to stop)\n`));
