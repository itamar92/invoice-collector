import { deflateSync, inflateSync } from 'node:zlib';

/** The bytes are not an image this module can wrap. */
export class ImageError extends Error {
  constructor(message: string) { super(message); this.name = 'ImageError'; }
}

export interface JpegInfo { width: number; height: number; components: number; orientation: number }

export function isJpeg(data: Buffer): boolean {
  return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}

/** EXIF orientation (1-8) from an APP1 segment body, or 1 when absent or malformed. */
function exifOrientation(seg: Buffer): number {
  if (seg.length < 14 || seg.toString('latin1', 0, 6) !== 'Exif\0\0') return 1;
  const tiff = seg.subarray(6);
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const le = order === 'II';
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  try {
    const ifd = u32(4);
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === 0x0112) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
  } catch { /* offsets outside the segment */ }
  return 1;
}

/** Reads size, colour components and EXIF orientation from the JPEG headers (nothing is decoded). */
export function jpegInfo(data: Buffer): JpegInfo {
  if (!isJpeg(data)) throw new ImageError('not a JPEG');
  let orientation = 1;
  let p = 2;
  while (p + 4 <= data.length) {
    if (data[p] !== 0xff) throw new ImageError('corrupt JPEG');
    const marker = data[p + 1];
    if (marker === 0xff) { p++; continue; } // fill byte
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { p += 2; continue; } // no length
    const len = data.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > data.length) throw new ImageError('corrupt JPEG');
    const body = data.subarray(p + 4, p + 2 + len);
    if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(body);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (body.length < 6) throw new ImageError('corrupt JPEG');
      const height = body.readUInt16BE(1);
      const width = body.readUInt16BE(3);
      const components = body[5];
      if (body[0] !== 8) throw new ImageError('unsupported JPEG (not 8-bit)');
      if (!width || !height) throw new ImageError('corrupt JPEG');
      if (components !== 1 && components !== 3 && components !== 4) throw new ImageError('unsupported JPEG colour format');
      return { width, height, components, orientation };
    }
    if (marker === 0xda) break; // image data starts: no frame header before it
    p += 2 + len;
  }
  throw new ImageError('corrupt JPEG');
}

/** Long side of the page in points (A4 height); the image keeps its proportions. */
const PAGE_LONG_SIDE = 842;
const ROTATE: Record<number, number> = { 1: 0, 2: 0, 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 };
const COLOR_SPACE: Record<number, string> = { 1: '/DeviceGray', 3: '/DeviceRGB', 4: '/DeviceCMYK' };

/**
 * Wraps a JPEG photo in a one-page PDF without re-encoding it (the JPEG bytes are embedded as they are), so a
 * photographed receipt goes through the same pipeline as a scanned PDF. The page is turned per the EXIF
 * orientation. The output depends only on the input bytes, so the same photo always gives the same file.
 */
export function jpegToPdf(jpeg: Buffer): Buffer {
  const info = jpegInfo(jpeg);
  // Adobe CMYK JPEGs store inverted values.
  const decode = info.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
  return imagePdf(info.width, info.height, ROTATE[info.orientation],
    `/ColorSpace ${COLOR_SPACE[info.components]} /BitsPerComponent 8 /Filter /DCTDecode${decode}`, jpeg);
}

/** One page sized to the image (long side A4 height) showing it full-page; `dict` describes the image stream. */
function imagePdf(width: number, height: number, rotate: number, dict: string, data: Buffer): Buffer {
  const scale = PAGE_LONG_SIDE / Math.max(width, height);
  const w = +(width * scale).toFixed(2);
  const h = +(height * scale).toFixed(2);
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  const objects: (string | Buffer)[][] = [
    ['<< /Type /Catalog /Pages 2 0 R >>'],
    ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Rotate ${rotate} `
      + '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'],
    [`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ${dict} `
      + `/Length ${data.length} >>\nstream\n`, data, '\nendstream'],
    [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`],
  ];

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let size = chunks[0].length;
  const push = (b: string | Buffer) => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    chunks.push(buf);
    size += buf.length;
  };
  const offsets: number[] = [];
  objects.forEach((parts, i) => {
    offsets.push(size);
    push(`${i + 1} 0 obj\n`);
    for (const part of parts) push(part);
    push('\nendobj\n');
  });
  const xref = size;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const o of offsets) push(`${String(o).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

// ---------- PNG ----------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Larger images are refused rather than decoded (memory on a small VM). */
export const MAX_PNG_PIXELS = 30_000_000;
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
// Adam7 passes: x start, y start, x step, y step.
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

export function isPng(data: Buffer): boolean {
  return data.length > 8 && data.subarray(0, 8).equals(PNG_SIGNATURE);
}

export interface DecodedImage { width: number; height: number; gray: boolean; pixels: Buffer }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decodes a PNG (any standard colour type and depth, interlaced or not) to 8-bit gray or RGB, with any
 * transparency flattened onto white, using only zlib.
 */
export function decodePng(data: Buffer): DecodedImage {
  if (!isPng(data)) throw new ImageError('not a PNG');
  let p = 8;
  let ihdr: Buffer | null = null;
  let plte: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (p + 8 <= data.length) {
    const len = data.readUInt32BE(p);
    const type = data.toString('latin1', p + 4, p + 8);
    if (p + 12 + len > data.length) throw new ImageError('corrupt PNG');
    const body = data.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = body;
    else if (type === 'PLTE') plte = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr || ihdr.length < 13 || idat.length === 0) throw new ImageError('corrupt PNG');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (!width || !height) throw new ImageError('corrupt PNG');
  if (!DEPTHS[colorType]?.includes(depth) || ihdr[10] !== 0 || ihdr[11] !== 0 || interlace > 1) {
    throw new ImageError('unsupported PNG format');
  }
  if (width * height > MAX_PNG_PIXELS) throw new ImageError('image is too large');
  if (colorType === 3 && (!plte || plte.length < 3)) throw new ImageError('corrupt PNG');

  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  const dims = passes.map(([x0, y0, dx, dy]) => [Math.ceil((width - x0) / dx), Math.ceil((height - y0) / dy)]);
  const expected = dims.reduce((n, [pw, ph]) => (pw && ph ? n + ph * (1 + Math.ceil((pw * bitsPerPixel) / 8)) : n), 0);
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch {
    throw new ImageError('corrupt PNG');
  }
  if (raw.length < expected) throw new ImageError('corrupt PNG');

  const gray = colorType === 0 || colorType === 4;
  const outChannels = gray ? 1 : 3;
  const pixels = Buffer.alloc(width * height * outChannels);
  const maxSample = (1 << depth) - 1;
  const sample = (row: Buffer, i: number): number => {
    if (depth === 8) return row[i];
    if (depth === 16) return row.readUInt16BE(i * 2);
    const bit = i * depth;
    return (row[bit >> 3] >> (8 - depth - (bit & 7))) & maxSample;
  };
  const to8 = (v: number) => (depth === 16 ? v >> 8 : depth < 8 ? Math.round((v * 255) / maxSample) : v);
  const key = trns && colorType === 0 && trns.length >= 2 ? [trns.readUInt16BE(0)]
    : trns && colorType === 2 && trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)]
      : null;
  const blend = (c: number, a: number) => Math.round((c * a + 255 * (255 - a)) / 255);

  let off = 0;
  passes.forEach(([x0, y0, dx, dy], n) => {
    const [pw, ph] = dims[n];
    if (!pw || !ph) return;
    const rowBytes = Math.ceil((pw * bitsPerPixel) / 8);
    let prev = Buffer.alloc(rowBytes);
    for (let y = 0; y < ph; y++) {
      const filter = raw[off];
      const row = Buffer.from(raw.subarray(off + 1, off + 1 + rowBytes));
      off += 1 + rowBytes;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        switch (filter) {
          case 0: break;
          case 1: row[i] = (row[i] + a) & 0xff; break;
          case 2: row[i] = (row[i] + b) & 0xff; break;
          case 3: row[i] = (row[i] + ((a + b) >> 1)) & 0xff; break;
          case 4: row[i] = (row[i] + paeth(a, b, c)) & 0xff; break;
          default: throw new ImageError('corrupt PNG');
        }
      }
      prev = row;
      const outY = y0 + y * dy;
      for (let x = 0; x < pw; x++) {
        const o = ((outY * width) + x0 + x * dx) * outChannels;
        const s = x * channels;
        if (colorType === 3) {
          const idx = sample(row, s);
          if (idx * 3 + 2 >= plte!.length) throw new ImageError('corrupt PNG');
          const alpha = trns && idx < trns.length ? trns[idx] : 255;
          for (let k = 0; k < 3; k++) pixels[o + k] = blend(plte![idx * 3 + k], alpha);
          continue;
        }
        const vals: number[] = [];
        for (let k = 0; k < channels; k++) vals.push(sample(row, s + k));
        const colour = vals.slice(0, outChannels);
        let alpha = channels === 2 || channels === 4 ? to8(vals[channels - 1]) : 255;
        if (key && colour.every((v, k) => v === key[k])) alpha = 0;
        for (let k = 0; k < outChannels; k++) pixels[o + k] = blend(to8(colour[k]), alpha);
      }
    }
  });
  return { width, height, gray, pixels };
}

/** A PNG in a one-page PDF (decoded, transparency on white, recompressed losslessly). Deterministic. */
export function pngToPdf(png: Buffer): Buffer {
  const img = decodePng(png);
  return imagePdf(img.width, img.height, 0,
    `/ColorSpace ${img.gray ? '/DeviceGray' : '/DeviceRGB'} /BitsPerComponent 8 /Filter /FlateDecode`,
    deflateSync(img.pixels));
}

/** A JPEG or PNG image as a one-page PDF; anything else throws ImageError. */
export function imageToPdf(data: Buffer): Buffer {
  if (isJpeg(data)) return jpegToPdf(data);
  if (isPng(data)) return pngToPdf(data);
  throw new ImageError('not a JPEG or PNG image');
}
