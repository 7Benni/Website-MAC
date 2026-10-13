// Run by Publish.command before uploading: shrinks new photos in photos/ to
// 3000px and removes GPS location (the repository is public). Camera info is kept.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import '../src/assets/exif-clean.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_EDGE = 3000;
const X = globalThis.ExifClean;

const changed = execSync('git status --porcelain -z -uall -- photos', { cwd: ROOT }).toString()
  .split('\0').filter(Boolean)
  .filter((l) => /^(\?\?| ?A| ?M)/.test(l))
  .map((l) => l.slice(3))
  .filter((f) => /\.(jpe?g|png|webp|tiff?)$/i.test(f));

for (const rel of changed) {
  const file = path.join(ROOT, rel);
  const bytes = new Uint8Array(await fs.readFile(file));
  const isJpeg = /\.jpe?g$/i.test(rel);
  const meta = await sharp(bytes).metadata();
  const long = Math.max(meta.width, meta.height);
  const pos = isJpeg ? X.find(bytes) : null;
  const clean = (opts) => { try { return X.clean(bytes.subarray(pos.start, pos.end), opts); } catch { return { seg: null, hadGps: true }; } };

  if (long > MAX_EDGE || !isJpeg) {
    const out = await sharp(bytes).rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92, mozjpeg: true }).toBuffer();
    const seg = pos ? clean({ resetOrientation: true }).seg : null;
    const target = file.replace(/\.[^.]+$/, '.jpg');
    await fs.writeFile(target, X.insert(new Uint8Array(out), seg));
    if (target !== file) await fs.rm(file);
    console.log(`  resized ${rel}`);
  } else if (pos) {
    const { seg, hadGps } = clean();
    if (hadGps) { await fs.writeFile(file, X.replace(bytes, pos, seg)); console.log(`  removed location from ${rel}`); }
  }
}
