import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInvoiceLinks, downloadPdf, LinkError } from '../server/sources/links.js';

const pub = async () => [{ address: '93.184.216.34', family: 4 }];
const code = (c: string) => (e: unknown) => e instanceof LinkError && e.code === c;
const resp = (body: BodyInit | null, init?: ResponseInit) => new Response(body, init);

test('findInvoiceLinks picks the invoice anchor and skips unsubscribe', () => {
  const html = `
    <a href="https://shop.example/u?id=1&amp;x=2">הורדת חשבונית</a>
    <a href="https://shop.example/unsubscribe?id=1">Unsubscribe from download list</a>
    <a href="https://shop.example/privacy">privacy</a>
    <a href="mailto:a@b.co">receipt</a>
    <a href="https://shop.example/about">About us</a>
    <a href="https://shop.example/u?id=1&amp;x=2">download</a>`;
  const text = 'also https://cdn.example/files/a.pdf here';
  assert.deepEqual(findInvoiceLinks(html, text), [
    'https://shop.example/u?id=1&x=2',
    'https://cdn.example/files/a.pdf',
  ]);
});

test('findInvoiceLinks caps at 5', () => {
  const html = Array.from({ length: 9 }, (_, i) => `<a href="https://x.example/invoice/${i}">x</a>`).join('');
  assert.equal(findInvoiceLinks(html, '').length, 5);
});

test('downloadPdf blocks literal private IPs and non-http schemes', async () => {
  let called = false;
  const fetchImpl = (async () => { called = true; return resp('x'); }) as typeof fetch;
  for (const u of ['http://127.0.0.1:1/a', 'http://[::1]/a', 'http://10.0.0.5/a', 'http://169.254.169.254/', 'http://[::ffff:127.0.0.1]/', 'http://[fe80::1]/', 'http://[fc00::1]/']) {
    await assert.rejects(() => downloadPdf(u, { fetchImpl }), code('link_blocked'), u);
  }
  await assert.rejects(() => downloadPdf('file:///etc/passwd', { fetchImpl }), code('link_blocked'));
  assert.equal(called, false);
});

test('downloadPdf blocks a host resolving to ANY blocked address', async () => {
  const resolve = async () => [{ address: '93.184.216.34', family: 4 }, { address: '192.168.1.1', family: 4 }];
  await assert.rejects(() => downloadPdf('https://a.example/x', { resolve, fetchImpl: (async () => resp('%PDF-')) as typeof fetch }), code('link_blocked'));
});

test('downloadPdf returns a valid PDF', async () => {
  const fetchImpl = (async () => resp('%PDF-1.4 hello')) as typeof fetch;
  const b = await downloadPdf('https://a.example/x', { resolve: pub, fetchImpl });
  assert.equal(b.toString().startsWith('%PDF-'), true);
});

test('downloadPdf rejects html, non-2xx, and oversize bodies', async () => {
  await assert.rejects(() => downloadPdf('https://a.example/x', { resolve: pub, fetchImpl: (async () => resp('<html>')) as typeof fetch }), code('link_not_pdf'));
  await assert.rejects(() => downloadPdf('https://a.example/x', { resolve: pub, fetchImpl: (async () => resp('no', { status: 404 })) as typeof fetch }), code('link_failed'));
  const big = (async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(65);
    chunk.set(Buffer.from('%PDF-'));
    let n = 0;
    return resp(new ReadableStream({ pull(c) { if (n++ < 25) c.enqueue(chunk); else c.close(); } }));
  }) as typeof fetch;
  await assert.rejects(() => downloadPdf('https://a.example/x', { resolve: pub, fetchImpl: big }), code('link_too_large'));
});

test('downloadPdf follows redirects, re-checks them, and caps at 3', async () => {
  const hops: string[] = [];
  const redirectTo = (loc: string) => resp(null, { status: 302, headers: { location: loc } });
  const blocked = (async (u: string) => { hops.push(u); return u.endsWith('/a') ? redirectTo('http://127.0.0.1/secret') : resp('%PDF-'); }) as unknown as typeof fetch;
  await assert.rejects(() => downloadPdf('https://a.example/a', { resolve: pub, fetchImpl: blocked }), code('link_blocked'));
  assert.deepEqual(hops, ['https://a.example/a']);

  let n = 0;
  const loop = (async () => redirectTo(`/r${n++}`)) as unknown as typeof fetch;
  await assert.rejects(() => downloadPdf('https://a.example/a', { resolve: pub, fetchImpl: loop }), code('link_failed'));
  assert.equal(n, 4);

  const ok = (async (u: string) => u.endsWith('/a') ? redirectTo('/b') : resp('%PDF-ok')) as unknown as typeof fetch;
  assert.equal((await downloadPdf('https://a.example/a', { resolve: pub, fetchImpl: ok })).length, 7);
});

const AKUM_HTML = `
  <a href="https://acum.org.il/contact/">לבירורים לחץ כאן</a>
  <a href="http://www.invoice-one.com">לחץ כאן</a>
  <a href="https://invoice-one.com/ViewerNew/pages/Y_GreeViewer_unsubscribe/ABC123">לחץ כאן</a>
  <a href="https://invoice-one.com/ViewerNew/pages/Y_GreeViewer_document/ABC123">לחץ כאן לצפיה במסמך</a>`;

test('findInvoiceLinks puts a known viewer link (invoice-one) first and drops its unsubscribe link', () => {
  const links = findInvoiceLinks(AKUM_HTML, '');
  assert.equal(links[0], 'https://invoice-one.com/ViewerNew/pages/Y_GreeViewer_document/ABC123');
  assert.equal(links.some((l) => l.includes('unsubscribe')), false);
});

test('downloadPdf fetches an invoice-one document through GetPDF and decodes it', async () => {
  const asked: string[] = [];
  const pdf = Buffer.from('%PDF-1.7 akum');
  const fetchImpl = (async (u: string) => {
    asked.push(u);
    return resp(JSON.stringify({ Entity: { FileName: 'Archive_Invoice1.pdf', ArrData: pdf.toString('base64') } }));
  }) as unknown as typeof fetch;
  for (const link of [
    'https://invoice-one.com/ViewerNew/pages/Y_GreeViewer_document/ABC123',
    'https://www.invoice-one.com/viewernew/pages/GreeViewer_document/ABC123',
  ]) {
    const b = await downloadPdf(link, { resolve: pub, fetchImpl });
    assert.equal(b.toString(), '%PDF-1.7 akum');
  }
  assert.deepEqual(asked, Array(2).fill('https://invoice-one.com/viewernew/api/GreeViewer/Document/GetPDF?DocumentID=ABC123'));
});

test('downloadPdf rejects an invoice-one answer without a PDF', async () => {
  const link = 'https://invoice-one.com/ViewerNew/pages/Y_GreeViewer_document/ABC123';
  const answer = (body: string) => (async () => resp(body)) as typeof fetch;
  await assert.rejects(() => downloadPdf(link, { resolve: pub, fetchImpl: answer('<html>') }), code('link_not_pdf'));
  await assert.rejects(() => downloadPdf(link, { resolve: pub, fetchImpl: answer('{"Entity":null}') }), code('link_not_pdf'));
  const notPdf = Buffer.from('hello').toString('base64');
  await assert.rejects(() => downloadPdf(link, { resolve: pub, fetchImpl: answer(`{"Entity":{"ArrData":"${notPdf}"}}`) }), code('link_not_pdf'));
});

test('a lookalike host is not treated as invoice-one', async () => {
  const asked: string[] = [];
  const fetchImpl = (async (u: string) => { asked.push(u); return resp('%PDF-x'); }) as unknown as typeof fetch;
  await downloadPdf('https://invoice-one.com.evil.example/ViewerNew/pages/Y_GreeViewer_document/ABC123', { resolve: pub, fetchImpl });
  assert.deepEqual(asked, ['https://invoice-one.com.evil.example/ViewerNew/pages/Y_GreeViewer_document/ABC123']);
});
