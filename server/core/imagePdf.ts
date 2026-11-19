/** The bytes are not a JPEG this module can wrap. */
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
  const scale = PAGE_LONG_SIDE / Math.max(info.width, info.height);
  const w = +(info.width * scale).toFixed(2);
  const h = +(info.height * scale).toFixed(2);
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  // Adobe CMYK JPEGs store inverted values.
  const decode = info.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
  const objects: (string | Buffer)[][] = [
    ['<< /Type /Catalog /Pages 2 0 R >>'],
    ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Rotate ${ROTATE[info.orientation]} `
      + '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>'],
    [`<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} `
      + `/ColorSpace ${COLOR_SPACE[info.components]} /BitsPerComponent 8 /Filter /DCTDecode${decode} `
      + `/Length ${jpeg.length} >>\nstream\n`, jpeg, '\nendstream'],
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
