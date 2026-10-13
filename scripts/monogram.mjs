// Draws the initials (e.g. "BK") as SVG paths in the site's serif font,
// so the logo and icons look identical everywhere, without loading a font.
import path from 'node:path';
import { createRequire } from 'node:module';
import opentype from 'opentype.js';

const require = createRequire(import.meta.url);
const FONT = require.resolve('@fontsource/cormorant-garamond/files/cormorant-garamond-latin-500-normal.woff');

export function initials(site) {
  if (site.monogram) return String(site.monogram).slice(0, 3);
  const words = String(site.name || '').trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || '') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase() || '·';
}

// Returns { d, width, height } of the letters, tightly cropped.
export function monogramPath(text) {
  const font = opentype.loadSync(FONT);
  const size = 100;
  // Slight negative tracking so the letters sit together like a mark.
  const glyphs = font.stringToGlyphs(text);
  let x = 0;
  const parts = [];
  glyphs.forEach((g, i) => {
    parts.push(g.getPath(x, 0, size));
    x += (g.advanceWidth / font.unitsPerEm) * size;
    if (i < glyphs.length - 1) x += (font.getKerningValue(g, glyphs[i + 1]) / font.unitsPerEm) * size - size * 0.04;
  });
  const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  for (const p of parts) {
    const b = p.getBoundingBox();
    box.x1 = Math.min(box.x1, b.x1); box.y1 = Math.min(box.y1, b.y1);
    box.x2 = Math.max(box.x2, b.x2); box.y2 = Math.max(box.y2, b.y2);
  }
  const d = parts.map((p) => {
    for (const c of p.commands) {
      for (const k of ['x', 'x1', 'x2']) if (k in c) c[k] -= box.x1;
      for (const k of ['y', 'y1', 'y2']) if (k in c) c[k] -= box.y1;
    }
    return p.toPathData(2);
  }).join('');
  return { d, width: +(box.x2 - box.x1).toFixed(2), height: +(box.y2 - box.y1).toFixed(2) };
}

// Square icon: letters centered on a background.
export function iconSvg(mark, { bg = '#f5f4f0', fg = '#161616', size = 512, pad = 0.2, adaptive = false } = {}) {
  const inner = size * (1 - pad * 2);
  const scale = Math.min(inner / mark.width, inner / mark.height);
  const w = mark.width * scale, h = mark.height * scale;
  const tx = (size - w) / 2, ty = (size - h) / 2;
  const style = adaptive
    ? `<style>rect{fill:${bg}}path{fill:${fg}}@media (prefers-color-scheme:dark){rect{fill:${fg}}path{fill:${bg}}}</style>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${style}<rect width="${size}" height="${size}" rx="${size * 0.22}" ${adaptive ? '' : `fill="${bg}"`}/><path transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})" ${adaptive ? '' : `fill="${fg}"`} d="${mark.d}"/></svg>`;
}

export { path };
