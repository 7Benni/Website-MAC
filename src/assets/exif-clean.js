// Shared by the admin page (browser) and scripts/prepare.mjs (Mac):
// finds the EXIF block of a JPEG, removes GPS location and optionally resets
// the orientation, so camera info survives resizing without leaking location.
(function (g) {
  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  // Position of the APP1 "Exif" segment (marker included), or null.
  function find(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let i = 2;
    while (i + 8 <= bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      if (marker === 0xda || marker === 0xd9) return null;
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker === 0xe1 && bytes[i + 4] === 0x45 && bytes[i + 5] === 0x78 && bytes[i + 6] === 0x69 && bytes[i + 7] === 0x66) {
        return { start: i, end: i + 2 + len };
      }
      i += 2 + len;
    }
    return null;
  }

  // Returns { seg, hadGps } with a cleaned copy of the segment; throws on malformed data.
  function clean(segment, { resetOrientation = false } = {}) {
    const seg = new Uint8Array(segment);
    const t = 10;
    const dv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
    const le = dv.getUint16(t) === 0x4949;
    const u16 = (o) => dv.getUint16(t + o, le);
    const u32 = (o) => dv.getUint32(t + o, le);
    const ifd0 = u32(4);
    const n = u16(ifd0);
    let hadGps = false;
    for (let k = 0; k < n; k++) {
      const e = ifd0 + 2 + k * 12;
      const tag = u16(e);
      if (tag === 0x0112 && resetOrientation) dv.setUint16(t + e + 8, 1, le);
      if (tag === 0x8825) {
        hadGps = true;
        const gps = u32(e + 8);
        const gn = u16(gps);
        for (let j = 0; j < gn; j++) {
          const ge = gps + 2 + j * 12;
          const size = (SIZES[u16(ge + 2)] || 1) * u32(ge + 4);
          if (size > 4) { const off = u32(ge + 8); seg.fill(0, t + off, Math.min(seg.length, t + off + size)); }
        }
        seg.fill(0, t + gps, Math.min(seg.length, t + gps + 2 + gn * 12 + 4));
        // Drop the GPS pointer from IFD0 (tags are sorted, so nothing we need comes after it).
        const tableEnd = t + ifd0 + 2 + n * 12 + 4;
        seg.copyWithin(t + e, t + e + 12, tableEnd);
        dv.setUint16(t + ifd0, n - 1, le);
        seg.fill(0, tableEnd - 12, tableEnd);
        break;
      }
    }
    return { seg, hadGps };
  }

  // JPEG bytes with `seg` placed right after the SOI marker (replacing APP0/APP1 there).
  function insert(jpeg, seg) {
    let i = 2;
    while (jpeg[i] === 0xff && (jpeg[i + 1] === 0xe0 || jpeg[i + 1] === 0xe1)) i += 2 + ((jpeg[i + 2] << 8) | jpeg[i + 3]);
    const out = new Uint8Array(2 + (seg ? seg.length : 0) + jpeg.length - i);
    out.set([0xff, 0xd8], 0);
    if (seg) out.set(seg, 2);
    out.set(jpeg.subarray(i), 2 + (seg ? seg.length : 0));
    return out;
  }

  // Same image bytes, with the EXIF segment replaced (or removed when seg is null).
  function replace(bytes, pos, seg) {
    const out = new Uint8Array(bytes.length - (pos.end - pos.start) + (seg ? seg.length : 0));
    out.set(bytes.subarray(0, pos.start), 0);
    if (seg) out.set(seg, pos.start);
    out.set(bytes.subarray(pos.end), pos.start + (seg ? seg.length : 0));
    return out;
  }

  g.ExifClean = { find, clean, insert, replace };
})(typeof window !== 'undefined' ? window : globalThis);
