import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, getDb } from '../server/db.js';
import { setSecret } from '../server/secrets.js';
import { listItems, getItemPdf } from '../server/core/items.js';
import { extractPdfText } from '../server/core/pdfText.js';
import { ingestMessage } from '../server/sources/gmail.js';
import type { GmailMessage, GmailSource } from '../server/sources/gmail.js';
import {
  metaReceiptDocument, metaReceiptUrl, normalizeCookies, parseMetaReceipt, visualOrder,
} from '../server/sources/meta.js';

process.env.SECRET_KEY = 'test-key-for-unit-tests-only-0123456789';

beforeEach(() => { openDb(':memory:'); });

const HTML = readFileSync(new URL('./fixtures/meta-receipt.html', import.meta.url), 'utf8');
const pub = async () => [{ address: '157.240.1.35', family: 4 }];

test('parseMetaReceipt reads the receipt email', () => {
  const r = parseMetaReceipt(HTML)!;
  assert.equal(r.accountId, '111222333');
  assert.equal(r.txid, '444-555');
  assert.equal(r.accountName, 'Test Advertiser');
  assert.equal(r.referenceNumber, 'ABCD123XYZ');
  assert.equal(r.amountBilled, '₪1,234.50 ILS');
  assert.equal(r.paymentMethod, 'Visa ···· 1111');
  assert.equal(r.total, '₪1,234.50');
  assert.equal(r.billedBy, 'Meta Platforms Ireland Limited');
  assert.deepEqual(r.campaigns, [
    { name: 'תנועה - הופעה חיפה 12.2 - סרטון', results: '12,345 Impressions', amount: '₪1,000.00' },
    { name: 'Brand awareness', results: '2,000 Reach', amount: '₪234.50' },
  ]);
});

test('parseMetaReceipt ignores other emails', () => {
  assert.equal(parseMetaReceipt('<a href="https://www.facebook.com/somepage">Invoice</a> Amount billed'), null);
  assert.equal(parseMetaReceipt(HTML.replace(/act=111222333&amp;txid=444-555/, 'x=1')), null);
});

test('metaReceiptUrl points at the transaction PDF', () => {
  const u = new URL(metaReceiptUrl({ accountId: '1', txid: '2-3' }));
  assert.equal(u.hostname, 'business.facebook.com');
  assert.equal(u.searchParams.get('act'), '1');
  assert.equal(u.searchParams.get('txid'), '2-3');
  assert.equal(u.searchParams.get('pdf'), 'true');
});

test('visualOrder: Hebrew-first lines reverse, numbers and Latin words stay readable', () => {
  assert.equal(visualOrder('Plain English 12.2'), 'Plain English 12.2');
  assert.equal(visualOrder('אב 12.2 גד'), 'דג 12.2 בא');
  assert.equal(visualOrder('Brand (אב גד) 2026'), 'Brand (דג בא) 2026');
});

test('normalizeCookies accepts a Cookie header or one cookie per line', () => {
  assert.equal(normalizeCookies('Cookie: c_user=1; xs=abc%3A2'), 'c_user=1; xs=abc%3A2');
  assert.equal(normalizeCookies('c_user=1\nxs=abc\n\njunk'), 'c_user=1; xs=abc');
});

test('without Facebook cookies the PDF is built from the email and noted', async () => {
  let fetched = false;
  const doc = await metaReceiptDocument(parseMetaReceipt(HTML)!, '2026-11-09T12:00:00Z', {
    resolve: pub, fetchImpl: (async () => { fetched = true; return new Response('x'); }) as typeof fetch,
  });
  assert.equal(fetched, false);
  assert.equal(doc.name, 'meta-receipt-ABCD123XYZ-from-email.pdf');
  assert.equal(doc.note, 'made_from_email:no_facebook_login');
  const { text } = await extractPdfText(doc.data);
  for (const s of ['Meta ads receipt', 'Meta Platforms Ireland Limited', 'ABCD123XYZ', '1,234.50', 'This is not an invoice']) {
    assert.ok(text.includes(s), `missing "${s}"`);
  }
});

test('with cookies, Meta\'s own PDF is used and the cookies go to facebook.com only', async () => {
  setSecret('meta_cookies', 'Cookie: c_user=1; xs=secret');
  const seen: { url: string; cookie: string | null }[] = [];
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    seen.push({ url: u, cookie: h.get('cookie') });
    if (u.includes('business.facebook.com')) return new Response(null, { status: 302, headers: { location: 'https://cdn.fbsbx.example/r.pdf' } });
    return new Response('%PDF-1.4 meta');
  }) as unknown as typeof fetch;
  const doc = await metaReceiptDocument(parseMetaReceipt(HTML)!, '2026-11-09T12:00:00Z', { resolve: pub, fetchImpl });
  assert.equal(doc.name, 'meta-receipt-ABCD123XYZ.pdf');
  assert.equal(doc.note, undefined);
  assert.equal(doc.data.toString(), '%PDF-1.4 meta');
  assert.equal(seen[0].cookie, 'c_user=1; xs=secret');
  assert.equal(seen[1].cookie, null); // the redirect left facebook.com: no cookie
});

test('expired cookies (Meta answers with its login page) fall back to the email PDF', async () => {
  setSecret('meta_cookies', 'c_user=1; xs=old');
  const fetchImpl = (async () => new Response('<html>log in</html>')) as typeof fetch;
  const doc = await metaReceiptDocument(parseMetaReceipt(HTML)!, '2026-11-09T12:00:00Z', { resolve: pub, fetchImpl });
  assert.equal(doc.note, 'made_from_email:link_not_pdf');
  assert.ok(doc.name.endsWith('-from-email.pdf'));
});

test('ingest: a Meta receipt email becomes a queued item with the made-from-email note', async () => {
  const m: GmailMessage = {
    id: 'm1', threadId: 't1', sender: 'noreply@business-updates.facebook.com', subject: 'Your Meta ads receipt',
    receivedAt: '2026-11-09T12:00:00.000Z', pdfs: [], html: HTML, text: '',
  };
  const g: GmailSource = {
    listCandidateMessages: async () => ['m1'], searchMessages: async () => [],
    fetchHeaders: async () => ({ id: 'm1', sender: m.sender, subject: m.subject, receivedAt: m.receivedAt }),
    fetchMessage: async () => m, markHandled: async () => {},
  };
  await ingestMessage(g, 'm1', 'ongoing', { resolve: pub, fetchImpl: (async () => new Response('x')) as typeof fetch });
  const [it] = listItems({ messageId: 'm1' });
  assert.equal(it.state, 'queued');
  assert.equal(it.attachmentName, 'meta-receipt-ABCD123XYZ-from-email.pdf');
  assert.ok(getItemPdf(it.id)!.subarray(0, 5).toString() === '%PDF-');
  const notes = getDb().prepare('SELECT note FROM item_events WHERE item_id = ?').pluck().all(it.id);
  assert.deepEqual(notes, ['made_from_email:no_facebook_login']);
});
