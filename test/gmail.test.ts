import { test, beforeEach, after } from 'node:test';
import { freshAccounts, TEST_EMAIL } from './helpers.js';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb, getDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { setSecret, getSecret } from '../server/secrets.js';
import { getSettings, updateSettings } from '../server/settings.js';
import { listItems, transition, getEmail, createEmail } from '../server/core/items.js';
import { TransientError } from '../server/core/types.js';
import {
  GmailClient, INVOICE_QUERY, ingestMessage, markHandledIfComplete, buildMime, bareAddress,
} from '../server/sources/gmail.js';
import type { GmailMessage, GmailSource } from '../server/sources/gmail.js';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { getItemPdf } from '../server/core/items.js';
import { jpegToPdf } from '../server/core/imagePdf.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';
process.env.APP_PASSWORD = 'pw';
process.env.PUBLIC_URL = 'https://ic.example.test';
process.env.GOOGLE_CLIENT_ID = 'gid';
process.env.GOOGLE_CLIENT_SECRET = 'gsecret';

beforeEach(() => { openDb(':memory:'); freshAccounts(); setSecret('gmail_refresh', 'RT'); });

const pdf = (s: string) => Buffer.from(`%PDF-1.4 ${s}`);
const msg = (id: string, over: Partial<GmailMessage> = {}): GmailMessage => ({
  id, threadId: 't' + id, sender: 'a@b.test', subject: 's', receivedAt: '2026-01-02T00:00:00.000Z',
  pdfs: [], html: '', text: '', ...over,
});
function fakeGmail(messages: Record<string, GmailMessage>) {
  const marked: string[] = [];
  const read: string[] = [];
  const g: GmailSource = {
    listCandidateMessages: async () => Object.keys(messages),
    searchMessages: async () => [],
    fetchHeaders: async (id) => ({ id, sender: messages[id].sender, subject: messages[id].subject, receivedAt: messages[id].receivedAt }),
    fetchMessage: async (id) => messages[id],
    markHandled: async (id, opts) => { marked.push(id); if (opts?.read) read.push(id); },
  };
  return { g, marked, read };
}
const pdfResponse = (body: Buffer) => new Response(body, { status: 200 });
const publicResolve = async () => [{ address: '93.184.216.34', family: 4 }];

// ---- ingest ----
test('already-ingested id is skipped', async () => {
  const { g } = fakeGmail({ m1: msg('m1', { pdfs: [{ name: 'a.pdf', data: pdf('1') }] }) });
  assert.equal((await ingestMessage(g, 'm1', 'ongoing')).skipped, false);
  assert.equal((await ingestMessage(g, 'm1', 'ongoing')).skipped, true);
  assert.equal(listItems({ messageId: 'm1' }).length, 1);
});

test('two PDFs make two items', async () => {
  const { g } = fakeGmail({ m1: msg('m1', { pdfs: [{ name: 'a.pdf', data: pdf('1') }, { name: 'b.pdf', data: pdf('2') }] }) });
  await ingestMessage(g, 'm1', 'backfill');
  assert.equal(listItems({ messageId: 'm1' }).length, 2);
  assert.equal(getEmail('m1')?.mode, 'backfill');
  assert.equal(getEmail('m1')?.sender, 'a@b.test');
});

const JPEG = readFileSync(new URL('./fixtures/receipt-photo.jpg', import.meta.url));
/** Minimal valid 2x1 RGB PNG. */
function tinyPng(): Buffer {
  const c = (t: string, b: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, Buffer.from(t), b, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), c('IHDR', ihdr),
    c('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 0, 0, 255]))), c('IEND', Buffer.alloc(0))]);
}

test('JPEG/PNG attachments of an email without a PDF become one-page PDF items; broken ones a placeholder', async () => {
  const { g } = fakeGmail({
    m1: msg('m1', { images: [{ name: 'Receipt.JPG', data: JPEG }, { name: 'scan.png', data: tinyPng() }, { name: 'x.png', data: Buffer.from('nope') }] }),
    m2: msg('m2', { pdfs: [{ name: 'a.pdf', data: pdf('1') }], images: [{ name: 'photo.jpg', data: JPEG }] }),
  });
  await ingestMessage(g, 'm1', 'ongoing');
  const items = listItems({ messageId: 'm1' });
  const byName = Object.fromEntries(items.map((i) => [i.attachmentName, i]));
  assert.deepEqual(Object.keys(byName).sort(), ['Receipt.pdf', 'scan.pdf', 'x.png']);
  assert.equal(byName['Receipt.pdf'].state, 'queued');
  assert.deepEqual(getItemPdf(byName['Receipt.pdf'].id), jpegToPdf(JPEG));
  assert.ok(getItemPdf(byName['scan.pdf'].id)!.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.equal(byName['x.png'].reason, 'no_document');
  await ingestMessage(g, 'm2', 'ongoing');
  assert.deepEqual(listItems({ messageId: 'm2' }).map((i) => i.attachmentName), ['a.pdf'], 'images ignored next to a PDF');
});

test('an attachment named .pdf that is not a PDF becomes a placeholder needing attention, never an item', async () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const { g } = fakeGmail({
    m1: msg('m1', { pdfs: [{ name: 'invoice.pdf', data: html }] }),
    m2: msg('m2', { pdfs: [{ name: 'a.pdf', data: pdf('ok') }, { name: 'fake.pdf', data: html }] }),
  });
  await ingestMessage(g, 'm1', 'ongoing');
  const [only] = listItems({ messageId: 'm1' });
  assert.equal(listItems({ messageId: 'm1' }).length, 1);
  assert.equal(only.state, 'needs_attention');
  assert.equal(only.reason, 'no_document');
  assert.equal(only.hasPdf, false);
  await ingestMessage(g, 'm2', 'ongoing');
  const states = listItems({ messageId: 'm2' }).map((i) => `${i.state}:${i.hasPdf}`).sort();
  assert.deepEqual(states, ['needs_attention:false', 'queued:true']);
});

test('link-only email: item from downloaded PDF', async () => {
  const { g } = fakeGmail({ m1: msg('m1', { html: '<a href="https://files.example.test/invoice/1">Download invoice</a>' }) });
  await ingestMessage(g, 'm1', 'ongoing', { resolve: publicResolve, fetchImpl: (async () => pdfResponse(pdf('linked'))) as typeof fetch });
  const items = listItems({ messageId: 'm1' });
  assert.equal(items.length, 1);
  assert.equal(items[0].state, 'queued');
  assert.equal(items[0].hasPdf, true);
});

test('link returning HTML makes a link_not_pdf placeholder', async () => {
  const { g } = fakeGmail({ m1: msg('m1', { text: 'see https://files.example.test/invoice/1' }) });
  await ingestMessage(g, 'm1', 'ongoing', { resolve: publicResolve, fetchImpl: (async () => pdfResponse(Buffer.from('<html>'))) as typeof fetch });
  const [it] = listItems({ messageId: 'm1' });
  assert.equal(it.state, 'needs_attention');
  assert.equal(it.reason, 'link_not_pdf');
  assert.equal(it.hasPdf, false);
});

test('no PDF and no links makes a no_document placeholder', async () => {
  const { g } = fakeGmail({ m1: msg('m1', { text: 'hello' }) });
  await ingestMessage(g, 'm1', 'ongoing');
  const [it] = listItems({ messageId: 'm1' });
  assert.equal(it.reason, 'no_document');
});

test('ingest is atomic: failing createItem leaves no email row, retry creates both', async () => {
  const msgs: Record<string, GmailMessage> = { m1: msg('m1', { pdfs: [{ name: 'a.pdf', data: pdf('1') }, { name: 'b.pdf', data: pdf('2') }] }) };
  const { g } = fakeGmail(msgs);
  // The second item insert fails inside the transaction.
  getDb().exec(`CREATE TEMP TRIGGER fail_b BEFORE INSERT ON items WHEN NEW.attachment_name = 'b.pdf'
                BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END;`);
  await assert.rejects(ingestMessage(g, 'm1', 'ongoing'), /synthetic insert failure/);
  assert.equal(getEmail('m1'), undefined);
  assert.equal(listItems({ messageId: 'm1' }).length, 0);
  getDb().exec('DROP TRIGGER fail_b');
  await ingestMessage(g, 'm1', 'ongoing');
  assert.equal(listItems({ messageId: 'm1' }).length, 2);
});

test('email row with zero items is re-ingested; zero-item message is never labelled', async () => {
  createEmail({ messageId: 'm1', threadId: 't', sender: 'a@b.test', subject: 's', receivedAt: '2026-01-02T00:00:00.000Z', mode: 'ongoing' });
  const { g, marked } = fakeGmail({ m1: msg('m1', { pdfs: [{ name: 'a.pdf', data: pdf('1') }] }) });
  assert.equal(await markHandledIfComplete(g, 'm1'), false);
  assert.deepEqual(marked, []);
  assert.equal((await ingestMessage(g, 'm1', 'ongoing')).skipped, false);
  assert.equal(listItems({ messageId: 'm1' }).length, 1);
});

test('link fallback stops at the first successful PDF', async () => {
  const { g } = fakeGmail({ m1: msg('m1', { text: 'https://files.example.test/invoice/1 https://files.example.test/invoice/2' }) });
  const urls: string[] = [];
  await ingestMessage(g, 'm1', 'ongoing', { resolve: publicResolve, fetchImpl: (async (u: string) => { urls.push(String(u)); return pdfResponse(pdf(String(u))); }) as unknown as typeof fetch });
  assert.equal(listItems({ messageId: 'm1' }).length, 1);
  assert.equal(urls.length, 1);
});

// ---- marking ----
test('markHandledIfComplete waits for terminal items, then labels once', async () => {
  const { g, marked } = fakeGmail({ m1: msg('m1', { pdfs: [{ name: 'a.pdf', data: pdf('1') }, { name: 'b.pdf', data: pdf('2') }] }) });
  await ingestMessage(g, 'm1', 'ongoing');
  const [a, b] = listItems({ messageId: 'm1' });
  transition(a.id, 'done');
  transition(b.id, 'needs_attention', 'ai_failed');
  assert.equal(await markHandledIfComplete(g, 'm1'), false);
  assert.deepEqual(marked, []);
  transition(b.id, 'done');
  assert.equal(await markHandledIfComplete(g, 'm1'), true);
  assert.deepEqual(marked, ['m1']);
  assert.equal(getEmail('m1')?.gmailMarked, true);
  assert.equal(await markHandledIfComplete(g, 'm1'), false);
  assert.deepEqual(marked, ['m1']);
});

// ---- client ----
interface Call { url: string; init: RequestInit }
function fakeFetch(handler: (c: Call, n: number) => Response) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    return handler(c, calls.push(c) - 1);
  }) as typeof fetch;
  return { impl, calls };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const isToken = (c: Call) => c.url.includes('oauth2.googleapis.com/token');
const q = (c: Call) => new URL(c.url).searchParams.get('q');

test('query strings: labelled and unlabelled, all pages followed', async () => {
  updateSettings({ gmailLabel: 'Invoices' });
  const f = fakeFetch((c) => {
    if (isToken(c)) return json(200, { access_token: 'AT', expires_in: 3600 });
    return new URL(c.url).searchParams.get('pageToken')
      ? json(200, { messages: [{ id: 'm3' }] })
      : json(200, { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'P2' });
  });
  const gc = new GmailClient({ fetchImpl: f.impl });
  assert.deepEqual(await gc.listCandidateMessages({ after: '2026/01/01', labelled: true }), ['m1', 'm2', 'm3']);
  assert.equal(q(f.calls[1]), 'label:"Invoices" after:2026/01/01 -label:"invoice-collector/done"');
  await gc.listCandidateMessages({ after: '2026/01/01', labelled: false });
  assert.equal(q(f.calls[3]), `${INVOICE_QUERY} after:2026/01/01 -label:"invoice-collector/done"`);
  assert.match(INVOICE_QUERY, /^\("חשבונית מס" OR "קבלה" OR "tax invoice" OR invoice OR receipt\) /);
  assert.ok(!INVOICE_QUERY.includes('filename:pdf'), 'a PDF attachment alone is not enough');
  assert.ok(INVOICE_QUERY.includes('-subject:"הצעת מחיר"') && INVOICE_QUERY.includes('-subject:פוליסה'));
  assert.ok(INVOICE_QUERY.endsWith('-in:sent -in:chats'));
  assert.equal(getSettings().gmailLabel, 'Invoices');
});

test('fetchMessage walks MIME parts, decodes PDFs, bare lowercase sender', async () => {
  const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
  const full = {
    id: 'm1', threadId: 't1', internalDate: String(Date.UTC(2026, 0, 2)),
    payload: {
      mimeType: 'multipart/mixed',
      headers: [{ name: 'From', value: 'Vendor Ltd <Billing@Vendor.TEST>' }, { name: 'Subject', value: 'חשבונית' }],
      parts: [
        { mimeType: 'multipart/alternative', parts: [
          { mimeType: 'text/plain', filename: '', headers: [{ name: 'Content-Type', value: 'text/plain; charset=utf-8' }], body: { data: b64('שלום') } },
          { mimeType: 'text/html', filename: '', body: { data: b64('<p>hi</p>') } },
        ] },
        { mimeType: 'application/pdf', filename: 'inline.pdf', body: { data: b64(pdf('inline')) } },
        { mimeType: 'application/octet-stream', filename: 'Big.PDF', body: { attachmentId: 'att1' } },
        { mimeType: 'image/png', filename: 'x.png', body: { attachmentId: 'att2' } },
        { mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'att3', size: 2000 } },
        { mimeType: 'image/jpeg', filename: 'IMG_1.jpeg', body: { attachmentId: 'att4', size: 20_000 } },
        { mimeType: 'image/jpeg', filename: '', body: { attachmentId: 'att5', size: 20_000 } },
      ],
    },
  };
  const f = fakeFetch((c) => {
    if (isToken(c)) return json(200, { access_token: 'AT', expires_in: 3600 });
    if (c.url.includes('/attachments/att1')) return json(200, { data: b64(pdf('big')) });
    if (c.url.includes('/attachments/att4')) return json(200, { data: b64(Buffer.alloc(20_000, 1)) });
    return json(200, full);
  });
  const m = await new GmailClient({ fetchImpl: f.impl }).fetchMessage('m1');
  assert.equal(m.sender, 'billing@vendor.test');
  assert.equal(m.subject, 'חשבונית');
  assert.equal(m.receivedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(m.text, 'שלום');
  assert.equal(m.html, '<p>hi</p>');
  assert.deepEqual(m.pdfs.map((p) => p.name), ['inline.pdf', 'Big.PDF']);
  assert.equal(m.pdfs[1].data.toString(), '%PDF-1.4 big');
  assert.ok(!f.calls.some((c) => /att[235]/.test(c.url)), 'small, unsized or unnamed images are not downloaded');
  assert.deepEqual(m.images?.map((i) => [i.name, i.data.length]), [['IMG_1.jpeg', 20_000]]);
  assert.equal(bareAddress('x@y.z'), 'x@y.z');
});

test('401 refreshes once and retries once; token cached', async () => {
  let n = 0;
  const f = fakeFetch((c) => {
    if (isToken(c)) return json(200, { access_token: 'AT' + n, expires_in: 3600 });
    return ++n === 1 ? json(401, { error: { message: 'bad' } }) : json(200, { messages: [] });
  });
  const gc = new GmailClient({ fetchImpl: f.impl });
  await gc.listCandidateMessages({ after: '2026/01/01', labelled: false });
  assert.equal(f.calls.filter(isToken).length, 2);
  await gc.listCandidateMessages({ after: '2026/01/01', labelled: false });
  assert.equal(f.calls.filter(isToken).length, 2);
});

test('429, 5xx and network errors are TransientError', async () => {
  for (const status of [429, 503]) {
    const f = fakeFetch((c) => (isToken(c) ? json(200, { access_token: 'AT', expires_in: 3600 }) : json(status, {})));
    await assert.rejects(new GmailClient({ fetchImpl: f.impl }).fetchMessage('m'), TransientError);
  }
  const net = (async () => { throw new Error('boom'); }) as typeof fetch;
  await assert.rejects(new GmailClient({ fetchImpl: net }).fetchMessage('m'), TransientError);
});

test('markHandled creates the label once and only adds it', async () => {
  const f = fakeFetch((c) => {
    if (isToken(c)) return json(200, { access_token: 'AT', expires_in: 3600 });
    if (c.url.endsWith('/labels') && c.init.method === 'GET') return json(200, { labels: [{ id: 'L1', name: 'x' }] });
    if (c.url.endsWith('/labels')) return json(200, { id: 'LNEW', name: 'invoice-collector/done' });
    return json(200, {});
  });
  const gc = new GmailClient({ fetchImpl: f.impl });
  await gc.markHandled('m1');
  await gc.markHandled('m2', { read: true });
  assert.equal(f.calls.filter((c) => c.url.endsWith('/labels')).length, 2); // list + create, once
  const mods = f.calls.filter((c) => c.url.endsWith('/modify'));
  assert.equal(mods.length, 2);
  assert.deepEqual(JSON.parse(String(mods[0].init.body)), { addLabelIds: ['LNEW'] });
  assert.deepEqual(JSON.parse(String(mods[1].init.body)), { addLabelIds: ['LNEW'], removeLabelIds: ['UNREAD'] });
});

test('a message whose invoice was collected is marked read; one where nothing was collected stays unread', async () => {
  const { g, read } = fakeGmail({
    m1: msg('m1', { pdfs: [{ name: 'a.pdf', data: pdf('1') }] }),
    m2: msg('m2', { pdfs: [{ name: 'b.pdf', data: pdf('2') }] }),
  });
  await ingestMessage(g, 'm1', 'ongoing');
  await ingestMessage(g, 'm2', 'ongoing');
  transition(listItems({ messageId: 'm1' })[0].id, 'done');
  transition(listItems({ messageId: 'm2' })[0].id, 'ignored');
  assert.equal(await markHandledIfComplete(g, 'm1'), true);
  assert.equal(await markHandledIfComplete(g, 'm2'), true);
  assert.deepEqual(read, ['m1']);
});

test('a link that did not lead to a PDF keeps the host and the error on the placeholder\'s history', async () => {
  const { g } = fakeGmail({ m1: msg('m1', { html: '<a href="https://docs.vendor.test/invoice/123">חשבונית</a>' }) });
  await ingestMessage(g, 'm1', 'ongoing', {
    resolve: publicResolve, fetchImpl: (async () => new Response('<html>login</html>', { status: 200 })) as typeof fetch,
  });
  const [it] = listItems({ messageId: 'm1' });
  assert.equal(it.reason, 'link_not_pdf');
  const note = getDb().prepare('SELECT note FROM item_events WHERE item_id = ?').pluck().get(it.id) as string;
  assert.match(note, /^link_not_pdf: docs\.vendor\.test - /);
});

test('unmarkHandled removes the done label in one batchModify; no label, no call', async () => {
  const withLabel = fakeFetch((c) => {
    if (isToken(c)) return json(200, { access_token: 'AT', expires_in: 3600 });
    if (c.url.endsWith('/labels')) return json(200, { labels: [{ id: 'LD', name: 'invoice-collector/done' }] });
    return new Response(null, { status: 204 });
  });
  await new GmailClient({ fetchImpl: withLabel.impl }).unmarkHandled(['m1', 'm2']);
  const mods = withLabel.calls.filter((c) => c.url.endsWith('/messages/batchModify'));
  assert.equal(mods.length, 1);
  assert.deepEqual(JSON.parse(String(mods[0].init.body)), { ids: ['m1', 'm2'], removeLabelIds: ['LD'] });

  const noLabel = fakeFetch((c) => (isToken(c) ? json(200, { access_token: 'AT', expires_in: 3600 }) : json(200, { labels: [] })));
  await new GmailClient({ fetchImpl: noLabel.impl }).unmarkHandled(['m1']);
  assert.equal(noLabel.calls.filter((c) => c.url.includes('batchModify')).length, 0);
});

test('listLabels returns user label names, sorted, without the done label or system labels', async () => {
  const f = fakeFetch((c) => {
    if (isToken(c)) return json(200, { access_token: 'AT', expires_in: 3600 });
    return json(200, { labels: [
      { id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'L2', name: 'קבלות', type: 'user' },
      { id: 'L1', name: 'Invoices', type: 'user' }, { id: 'L3', name: 'invoice-collector/done', type: 'user' },
    ] });
  });
  assert.deepEqual(await new GmailClient({ fetchImpl: f.impl }).listLabels(), ['Invoices', 'קבלות']);
});

test('send builds a MIME with encoded Hebrew subject and filename', async () => {
  const f = fakeFetch((c) => (isToken(c) ? json(200, { access_token: 'AT', expires_in: 3600 }) : json(200, { id: 'sent1' })));
  const id = await new GmailClient({ fetchImpl: f.impl }).sendMailWithAttachment('in@box.test', 'חשבונית', 'קובץ.pdf', pdf('x'));
  assert.equal(id, 'sent1');
  const raw = Buffer.from(JSON.parse(String(f.calls[1].init.body)).raw, 'base64url').toString('utf8');
  assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(raw, /filename\*=UTF-8''%D7%A7/);
  assert.match(raw, /To: in@box\.test/);
  assert.ok(!/Subject: .*[^\x20-\x7e\r\n]/.test(raw));
  assert.ok(buildMime('a@b.c', 'x\r\nBcc: z', 'f.pdf', pdf('y')).toString().includes('Subject: x Bcc: z'));
});

// ---- OAuth ----
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });
async function start() {
  const s = await new Promise<Server>((r) => { const x = createApp().listen(0, '127.0.0.1', () => r(x)); });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
async function loginCookie(base: string) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: TEST_EMAIL, password: 'pw' }) });
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
}

test('google oauth start: login required, offline+consent, send scope only when asked', async () => {
  const base = await start();
  assert.equal((await fetch(`${base}/api/oauth/google/start`, { redirect: 'manual' })).status, 401);
  const cookie = await loginCookie(base);
  const a = new URL((await fetch(`${base}/api/oauth/google/start?send=0`, { redirect: 'manual', headers: { cookie } })).headers.get('location')!);
  assert.equal(a.origin + a.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(a.searchParams.get('access_type'), 'offline');
  assert.equal(a.searchParams.get('prompt'), 'consent');
  assert.equal(a.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(a.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(a.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.modify');
  assert.equal(a.searchParams.get('redirect_uri'), 'https://ic.example.test/api/oauth/google/callback');
  const b = new URL((await fetch(`${base}/api/oauth/google/start?send=1`, { redirect: 'manual', headers: { cookie } })).headers.get('location')!);
  assert.equal(b.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send');
});

test('google oauth callback stores refresh token and scopes; state is one-time', async () => {
  const base = await start();
  const cookie = await loginCookie(base);
  assert.equal((await fetch(`${base}/api/oauth/google/callback?code=c&state=nope`, { redirect: 'manual', headers: { cookie } })).status, 400);
  const s = await fetch(`${base}/api/oauth/google/start?send=1`, { redirect: 'manual', headers: { cookie } });
  const state = new URL(s.headers.get('location')!).searchParams.get('state')!;
  const realFetch = globalThis.fetch;
  let body: URLSearchParams | null = null;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      body = new URLSearchParams(String(init?.body));
      return json(200, { access_token: 'a', refresh_token: 'GRT', scope: 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send' });
    }
    return realFetch(url as string, init);
  }) as typeof fetch;
  try {
    const ok = await fetch(`${base}/api/oauth/google/callback?code=thecode&state=${state}`, { redirect: 'manual', headers: { cookie } });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), '/settings?connected=google');
    assert.equal(getSecret('gmail_refresh'), 'GRT');
    assert.deepEqual(getSettings().gmailScopes, ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send']);
    assert.equal(body!.get('client_secret'), 'gsecret');
    assert.equal(body!.get('redirect_uri'), 'https://ic.example.test/api/oauth/google/callback');
    assert.equal((await fetch(`${base}/api/oauth/google/callback?code=x&state=${state}`, { redirect: 'manual', headers: { cookie } })).status, 400);
  } finally { globalThis.fetch = realFetch; }
});
