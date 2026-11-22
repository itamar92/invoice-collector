import { test, beforeEach, after } from 'node:test';
import { freshAccounts, TEST_EMAIL } from './helpers.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb, getDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import type { ApiContext } from '../server/routes.js';
import { resetLoginLimiter } from '../server/auth.js';
import { ImageError, jpegInfo, jpegToPdf } from '../server/core/imagePdf.js';
import { getEmail, getItem, getItemPdf, listItems } from '../server/core/items.js';
import { extractPdfText } from '../server/core/pdfText.js';
import { recipeHistory, setVendorStatus } from '../server/core/recipeStore.js';
import type { Deps, ExtractedFields } from '../server/core/types.js';
import type { AiProvider, AiRequest } from '../server/ai/provider.js';
import { getSettings } from '../server/settings.js';
import type { GmailSource } from '../server/sources/gmail.js';
import { markHandledIfComplete } from '../server/sources/gmail.js';
import { UploadError, createUpload, toPdf } from '../server/sources/upload.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';
process.env.APP_PASSWORD = 'correct horse';

const JPEG = readFileSync(new URL('./fixtures/receipt-photo.jpg', import.meta.url));
const NOW = new Date('2026-06-15T09:00:00Z');
const FIELDS: ExtractedFields = {
  vendorName: 'תחנת דלק דמו', vendorTaxId: '510000001', docType: 'tax_invoice_receipt', docNumber: '7781',
  issueDate: '2026-06-14', total: 236, vat: 36, net: 200, currency: 'ILS', allocationNumber: null,
  description: 'תדלוק', category: 'רכב - דלק',
};

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
beforeEach(() => { openDb(':memory:'); freshAccounts(); resetLoginLimiter(); });

/** An AI that reads PDFs and answers with FIELDS; records what it was sent. */
function fakeAi(calls: AiRequest[] = []): AiProvider {
  return {
    name: 'fake', supportsPdf: true, ping: async () => {},
    completeJson: async (req) => { calls.push(req); return FIELDS; },
  };
}
const deps = (ai: AiProvider | null): Deps => ({
  storage: { exists: async () => ({ exists: false, sameContent: false }), put: async (f, n) => ({ path: `${f}/${n}`, existed: false }) },
  accounting: null, ai, settings: getSettings(), now: () => NOW,
});

async function boot(over: Partial<ApiContext> = {}) {
  const ctx: ApiContext = { getDeps: () => ({ deps: deps(fakeAi()), gmail: {} as GmailSource }), now: () => NOW, ...over };
  const app = createApp(ctx);
  const s = await new Promise<Server>((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: TEST_EMAIL, password: 'correct horse' }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const upload = (body: Buffer, type: string, name = 'receipt.jpg', auth = true) =>
    fetch(`${base}/api/uploads?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { ...(auth ? { cookie } : {}), 'content-type': type }, body,
    });
  return { upload };
}

// ---------- image → PDF ----------

test('jpegInfo reads the size and colour components from the headers', () => {
  assert.deepEqual(jpegInfo(JPEG), { width: 40, height: 60, components: 3, orientation: 1 });
  assert.throws(() => jpegInfo(Buffer.from('not an image')), ImageError);
  assert.throws(() => jpegInfo(JPEG.subarray(0, 20)), ImageError);
});

test('jpegToPdf embeds the photo unchanged in a one-page PDF that the text extractor sees as a scan', async () => {
  const pdf = jpegToPdf(JPEG);
  assert.ok(pdf.subarray(0, 8).toString('latin1').startsWith('%PDF-1.4'));
  assert.ok(pdf.includes(JPEG), 'the JPEG bytes are embedded as they are');
  assert.deepEqual(jpegToPdf(JPEG), pdf, 'same photo, same file (so re-sending it is caught as a duplicate)');
  const doc = await extractPdfText(pdf);
  assert.equal(doc.pages, 1);
  assert.equal(doc.isScan, true);
});

test('jpegToPdf turns the page per the EXIF orientation', () => {
  // APP1 "Exif" segment, big-endian TIFF, one IFD entry: Orientation (0x0112) = 6 (turn 90° clockwise).
  const tiff = Buffer.from('4d4d002a00000008' + '0001' + '011200030000000100060000' + '00000000', 'hex');
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(body.length + 2, 2);
  const rotated = Buffer.concat([JPEG.subarray(0, 2), head, body, JPEG.subarray(2)]);
  assert.equal(jpegInfo(rotated).orientation, 6);
  assert.ok(jpegToPdf(rotated).includes('/Rotate 90 '));
  assert.ok(jpegToPdf(JPEG).includes('/Rotate 0 '));
});

test('toPdf passes a PDF through and refuses anything that is neither a PDF nor a JPEG', () => {
  const pdf = Buffer.from('%PDF-1.4 fake');
  assert.equal(toPdf(pdf), pdf);
  assert.throws(() => toPdf(Buffer.from('\x89PNG\r\n\x1a\n....', 'latin1')), (e) => e instanceof UploadError && e.code === 'unsupported_file');
  assert.throws(() => toPdf(Buffer.alloc(0)), (e) => e instanceof UploadError && e.code === 'empty_file');
});

// ---------- intake ----------

test('createUpload stores a queued item under an upload: source row that Gmail is never asked about', async () => {
  const { id } = createUpload('telegram', '../../evil/קבלה.JPG', JPEG, NOW);
  const item = getItem(id)!;
  assert.equal(item.state, 'queued');
  assert.equal(item.attachmentName, 'קבלה.pdf');
  assert.ok(item.messageId.startsWith('upload:'));
  const email = getEmail(item.messageId)!;
  assert.equal(email.mode, 'manual');
  assert.equal(email.sender, 'telegram');
  assert.equal(email.gmailMarked, true);
  const gmail = { markHandled: async () => { throw new Error('must not be called'); } } as unknown as GmailSource;
  assert.equal(await markHandledIfComplete(gmail, item.messageId), false);
});

test('the same photo handed in twice is a duplicate of the first', () => {
  const first = createUpload('upload', 'a.jpg', JPEG, NOW);
  const second = createUpload('upload', 'b.jpg', JPEG, NOW);
  assert.equal(second.duplicateOf, first.id);
  assert.equal(getItem(second.id)!.state, 'dismissed');
});

// ---------- POST /api/uploads ----------

test('a photo upload is read by the AI as a PDF and waits for the vendor decision', async () => {
  const calls: AiRequest[] = [];
  const { upload } = await boot({ getDeps: () => ({ deps: deps(fakeAi(calls)), gmail: {} as GmailSource }) });
  const res = await upload(JPEG, 'image/jpeg', 'דלק.jpg');
  assert.equal(res.status, 201);
  const body = await res.json() as { id: string; duplicate: boolean; item: Record<string, unknown> };
  assert.equal(body.duplicate, false);
  assert.equal(body.item.state, 'awaiting_vendor');
  assert.ok(!('text' in body.item));
  const item = getItem(body.id)!;
  assert.equal(item.fields?.total, 236);
  assert.equal(item.provenance, 'ai');
  assert.ok(getItemPdf(body.id)!.subarray(0, 5).toString() === '%PDF-');
  // One extraction call, with the PDF attached and no sender; no recipe is written for a photo.
  assert.equal(calls.length, 1);
  assert.ok(calls[0].pdf && calls[0].user.includes('<sender></sender>'));
  assert.equal(recipeHistory(item.vendorKey!).length, 0);
  assert.equal(getSettings().lastAiSuccessAt, NOW.toISOString());
});

test('an upload from a known business vendor is filed in the same request', async () => {
  const { upload } = await boot();
  const first = await (await upload(JPEG, 'image/jpeg')).json() as { id: string };
  setVendorStatus(getItem(first.id)!.vendorKey!, 'business');
  getDb().prepare("UPDATE items SET state = 'dismissed' WHERE id = ?").run(first.id); // frees the doc number
  const pdf = Buffer.concat([jpegToPdf(JPEG), Buffer.from('\n% second copy\n')]);
  const res = await upload(pdf, 'application/pdf', 'scan.pdf');
  const body = await res.json() as { id: string; item: { state: string; storagePath: string } };
  assert.equal(res.status, 201);
  assert.equal(body.item.state, 'done');
  assert.match(body.item.storagePath, /דלק\/.*\.pdf$/);
});

test('uploading the same file again answers with the existing item', async () => {
  const { upload } = await boot();
  const first = await (await upload(JPEG, 'image/jpeg')).json() as { id: string };
  const res = await upload(JPEG, 'image/jpeg');
  assert.equal(res.status, 200);
  assert.deepEqual({ ...(await res.json() as object), item: undefined }, { id: first.id, duplicate: true, item: undefined });
});

test('without connected services the upload stays queued for the worker', async () => {
  const { upload } = await boot({ getDeps: () => { throw new Error('not connected'); } });
  const body = await (await upload(JPEG, 'image/jpeg')).json() as { item: { state: string } };
  assert.equal(body.item.state, 'queued');
});

test('upload refusals: no session, a file that is not a PDF or JPEG, a file over the limit', async () => {
  const { upload } = await boot();
  assert.equal((await upload(JPEG, 'image/jpeg', 'a.jpg', false)).status, 401);
  const bad = await upload(Buffer.from('GIF89a....'), 'image/gif');
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'unsupported_file' });
  const big = await upload(Buffer.alloc(15 * 1024 * 1024 + 1), 'application/pdf');
  assert.equal(big.status, 413);
  assert.deepEqual(await big.json(), { error: 'too_large' });
  assert.equal(listItems().length, 0);
});
