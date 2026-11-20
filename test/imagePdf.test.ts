import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import { ImageError, MAX_PNG_PIXELS, decodePng, imageToPdf, isPng, pngToPdf } from '../server/core/imagePdf.js';
import { extractPdfText } from '../server/core/pdfText.js';

// ---------- a small PNG encoder for the tests ----------

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]); // CRC is not checked
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Filters one scanline with `type` (0-4). */
function filterRow(row: Buffer, prev: Buffer, bpp: number, type: number): Buffer {
  const out = Buffer.alloc(row.length + 1);
  out[0] = type;
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0; const b = prev[i]; const c = i >= bpp ? prev[i - bpp] : 0;
    const pred = [0, a, b, (a + b) >> 1, paeth(a, b, c)][type];
    out[i + 1] = (row[i] - pred) & 0xff;
  }
  return out;
}

const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/**
 * samples[y][x] = array of channel values (already at `depth`). Packs, filters (rotating through every filter
 * type), optionally Adam7-interlaces, and wraps in PNG chunks.
 */
function encodePng(o: {
  width: number; height: number; depth: number; colorType: number; samples: number[][][];
  interlace?: boolean; plte?: Buffer; trns?: Buffer;
}): Buffer {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[o.colorType]!;
  const bitsPerPixel = channels * o.depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const passes = o.interlace ? ADAM7 : [[0, 0, 1, 1]];
  const parts: Buffer[] = [];
  let filterType = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((o.width - x0) / dx); const ph = Math.ceil((o.height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bitsPerPixel) / 8);
    let prev = Buffer.alloc(rowBytes);
    for (let y = 0; y < ph; y++) {
      const row = Buffer.alloc(rowBytes);
      let bit = 0;
      for (let x = 0; x < pw; x++) {
        for (const v of o.samples[y0 + y * dy][x0 + x * dx]) {
          if (o.depth === 16) { row.writeUInt16BE(v, bit >> 3); } else if (o.depth === 8) { row[bit >> 3] = v; } else {
            row[bit >> 3] |= v << (8 - o.depth - (bit & 7));
          }
          bit += o.depth;
        }
      }
      parts.push(filterRow(row, prev, bpp, filterType));
      filterType = (filterType + 1) % 5;
      prev = row;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(o.width, 0); ihdr.writeUInt32BE(o.height, 4);
  ihdr[8] = o.depth; ihdr[9] = o.colorType; ihdr[12] = o.interlace ? 1 : 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(o.plte ? [chunk('PLTE', o.plte)] : []),
    ...(o.trns ? [chunk('tRNS', o.trns)] : []),
    chunk('IDAT', deflateSync(Buffer.concat(parts))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const W = 11; const H = 7; // odd sizes exercise partial Adam7 passes and bit packing
const grid = <T>(f: (x: number, y: number) => T): T[][] =>
  Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => f(x, y)));
const rgbAt = (x: number, y: number) => [(x * 23) & 0xff, (y * 37) & 0xff, (x * y * 5 + 9) & 0xff];

function expectRgb(img: ReturnType<typeof decodePng>, f: (x: number, y: number) => number[]) {
  assert.equal(img.gray, false);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3;
    assert.deepEqual([...img.pixels.subarray(o, o + 3)], f(x, y), `pixel ${x},${y}`);
  }
}

// ---------- tests ----------

for (const interlace of [false, true]) {
  test(`decodePng RGB 8-bit, every filter type${interlace ? ', interlaced' : ''}`, () => {
    const png = encodePng({ width: W, height: H, depth: 8, colorType: 2, samples: grid(rgbAt), interlace });
    assert.ok(isPng(png));
    const img = decodePng(png);
    assert.equal(img.width, W); assert.equal(img.height, H);
    expectRgb(img, rgbAt);
  });
}

test('decodePng RGBA flattens transparency onto white; 16-bit is reduced to 8', () => {
  const samples = grid((x, y) => [...rgbAt(x, y), x === 0 ? 0 : x === 1 ? 128 : 255]);
  const blend = (c: number, a: number) => Math.round((c * a + 255 * (255 - a)) / 255);
  expectRgb(decodePng(encodePng({ width: W, height: H, depth: 8, colorType: 6, samples })),
    (x, y) => rgbAt(x, y).map((c) => blend(c, x === 0 ? 0 : x === 1 ? 128 : 255)));
  const s16 = grid((x, y) => [...rgbAt(x, y).map((c) => c * 257), 65535]);
  expectRgb(decodePng(encodePng({ width: W, height: H, depth: 16, colorType: 6, samples: s16, interlace: true })), rgbAt);
});

test('decodePng palette (4-bit, with tRNS) and gray (1-bit, gray+alpha)', () => {
  const plte = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const idx = (x: number, y: number) => (x + y) % 3;
  const pal = decodePng(encodePng({
    width: W, height: H, depth: 4, colorType: 3, samples: grid((x, y) => [idx(x, y)]), plte,
    trns: Buffer.from([255, 255, 0]),
  }));
  expectRgb(pal, (x, y) => (idx(x, y) === 2 ? [255, 255, 255] : [...plte.subarray(idx(x, y) * 3, idx(x, y) * 3 + 3)]));

  const bw = decodePng(encodePng({ width: W, height: H, depth: 1, colorType: 0, samples: grid((x, y) => [(x + y) & 1]) }));
  assert.equal(bw.gray, true);
  assert.deepEqual([...bw.pixels.subarray(0, 3)], [0, 255, 0]);
  const ga = decodePng(encodePng({ width: W, height: H, depth: 8, colorType: 4, samples: grid(() => [100, 0]) }));
  assert.equal(ga.gray, true);
  assert.equal(ga.pixels[0], 255, 'fully transparent gray is white');
});

test('pngToPdf: one-page PDF the text extractor sees as a scan, same bytes for the same image', async () => {
  const png = encodePng({ width: W, height: H, depth: 8, colorType: 2, samples: grid(rgbAt) });
  const pdf = pngToPdf(png);
  assert.ok(pdf.subarray(0, 8).toString('latin1').startsWith('%PDF-1.4'));
  assert.ok(pdf.includes('/FlateDecode') && pdf.includes(`/Width ${W} /Height ${H}`));
  assert.deepEqual(pngToPdf(png), pdf);
  // The embedded stream inflates back to the decoded pixels.
  const start = pdf.indexOf('stream\n', pdf.indexOf('/FlateDecode')) + 7;
  const len = Number(/\/FlateDecode \/Length (\d+)/.exec(pdf.toString('latin1'))![1]);
  assert.deepEqual(inflateSync(pdf.subarray(start, start + len)), decodePng(png).pixels);
  const doc = await extractPdfText(pdf);
  assert.equal(doc.pages, 1);
  assert.equal(doc.isScan, true);
  assert.deepEqual(imageToPdf(png), pdf);
});

test('broken, unsupported or huge PNGs are refused with ImageError', () => {
  const good = encodePng({ width: W, height: H, depth: 8, colorType: 2, samples: grid(rgbAt) });
  assert.throws(() => decodePng(good.subarray(0, 40)), ImageError);
  assert.throws(() => decodePng(Buffer.from('not a png')), ImageError);
  const bad = Buffer.from(good); bad[24] = 3; // bit depth 3
  assert.throws(() => decodePng(bad), ImageError);
  const huge = Buffer.from(good); huge.writeUInt32BE(MAX_PNG_PIXELS, 16); huge.writeUInt32BE(2, 20);
  assert.throws(() => decodePng(huge), /too large/);
  assert.throws(() => imageToPdf(Buffer.from('GIF89a....')), ImageError);
});
