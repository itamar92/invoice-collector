import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getDb, openDb } from '../server/db.js';
import { getItem, getItemPdf, listItems } from '../server/core/items.js';
import { extractPdfText } from '../server/core/pdfText.js';
import { compileRecipe, matchesRecipe, runRecipe } from '../server/core/recipe.js';
import { LinkError } from '../server/sources/links.js';
import { kvish6ApiUrl, kvish6Document, kvish6InvoiceId, parseKvish6Response } from '../server/sources/kvish6.js';
import { ingestMessage, refetchItem } from '../server/sources/gmail.js';
import type { GmailMessage, GmailSource } from '../server/sources/gmail.js';

beforeEach(() => { openDb(':memory:'); });
const notes = (id: string) => getDb().prepare('SELECT note FROM item_events WHERE item_id = ?').pluck().all(id) as (string | null)[];

const ID = 'a'.repeat(64);
// The email as Kvish 6 sends it (printernet tracking links around the service.kvish6.co.il viewer link).
const HTML = `<a href="https://nmall.printernet.co.il/ViewPage.aspx?ow=1&amp;pt=2">הצג את האימייל הזה בדפדפן שלך</a>
  <a href="https://service.kvish6.co.il/#/website/invoice?id=${ID}">לצפייה בחשבונית</a>
  <a href="https://service.kvish6.co.il/#/website/customer-area/login?x=1&amp;Button=Banner">באזור האישי שלך</a>`;

const answer = (over: Record<string, unknown> = {}) => ({
  Success: true,
  Message: 'OK',
  Payload: {
    CustomerName: 'ישראל ישראלי',
    AccountNumber: '1000001',
    IsLinkExpired: false,
    MonthInfo: [
      {
        Month: 11, Year: 2026, isDefualt: true,
        InvoiceInfo: [{
          InvoiceNum: '2260-000001', InvoiceAmount: '51.09', AccountNumber: '1000001',
          InvoicePeriod: '20/10/2026-19/11/2026', InvoiceDate: '20261120',
          VehicleTripsInfo: [{ VehiclePlateNumber: '1234567', TripsCount: 3, TripsAmount: '43.30' }],
        }],
      },
      { Month: 10, Year: 2026, isDefualt: false, InvoiceInfo: [{ InvoiceNum: '1268-000002', InvoiceAmount: '100.49', InvoiceDate: '20261021' }] },
      { Month: 6, Year: 2026, isDefualt: false, MonthDisplayTypeCode: 1, Text: 'לא הופקה חשבונית', InvoiceInfo: [] },
    ],
    ...over,
  },
});
const publicResolve = async () => [{ address: '93.184.216.34', family: 4 }];
const apiFetch = (body: unknown, seen: string[] = []) => (async (u: string) => {
  seen.push(String(u));
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

test('finds the invoice id in a Kvish 6 email, and nothing in other emails', () => {
  assert.equal(kvish6InvoiceId(HTML), ID);
  assert.equal(kvish6InvoiceId('', `see https://service.kvish6.co.il/#/website/invoice?id=${ID}`), ID);
  assert.equal(kvish6InvoiceId('<a href="https://service.kvish6.co.il/#/website/customer-area/login">x</a>'), null);
  assert.equal(kvish6InvoiceId('<a href="https://evil.example/#/website/invoice?id=abcdefabcdefabcdef">x</a>'), null);
  assert.equal(kvish6ApiUrl(ID), `https://service.kvish6.co.il/api/invoice/CheckLoginAndGetDigitalInvoice?id=${ID}`);
});

test('reads the month the page opens on; an expired link or an empty answer is a LinkError', () => {
  const inv = parseKvish6Response(answer());
  assert.deepEqual(inv, {
    invoiceNumber: '2260-000001', amount: '51.09', account: '1000001', customerName: 'ישראל ישראלי',
    period: '20/10/2026-19/11/2026', issueDate: '20/11/2026', trips: [{ plate: '1234567', trips: 3, amount: '43.30' }],
  });
  assert.throws(() => parseKvish6Response(answer({ IsLinkExpired: true })), (e: unknown) => e instanceof LinkError && /expired/.test(e.message));
  assert.throws(() => parseKvish6Response({ Success: false }), LinkError);
  assert.throws(() => parseKvish6Response(answer({ MonthInfo: [] })), LinkError);
});

test('the built PDF is read by the kvish6 starter recipe (vendor, date and total)', async () => {
  const seen: string[] = [];
  const doc = await kvish6Document(ID, { resolve: publicResolve, fetchImpl: apiFetch(answer(), seen) });
  assert.deepEqual(seen, [kvish6ApiUrl(ID)]);
  assert.equal(doc.name, 'kvish6-2260-000001.pdf');
  assert.equal(doc.note, 'made_from_vendor_data:kvish6');
  const { text } = await extractPdfText(doc.data);
  const recipe = compileRecipe(JSON.parse(readFileSync(new URL('../recipes/il/kvish6.json', import.meta.url), 'utf8')));
  assert.ok(matchesRecipe(recipe, 'kvish6@printernet.co.il', text));
  const f = runRecipe(recipe, text);
  assert.equal(f.issueDate, '2026-11-20');
  assert.equal(f.total, 51.09);
});

const msg = (over: Partial<GmailMessage> = {}): GmailMessage => ({
  id: 'k1', threadId: 'tk1', sender: 'kvish6@printernet.co.il', subject: 'החשבונית החודשית שלך מכביש 6 (1)',
  receivedAt: '2026-11-25T18:00:00.000Z', pdfs: [], html: HTML, text: '', ...over,
});
const gmail = (m: GmailMessage): GmailSource => ({
  listCandidateMessages: async () => [m.id],
  searchMessages: async () => [],
  fetchHeaders: async (id) => ({ id, sender: m.sender, subject: m.subject, receivedAt: m.receivedAt }),
  fetchMessage: async () => m,
  markHandled: async () => {},
});

test('ingest: a Kvish 6 email becomes a queued item built from the invoice data', async () => {
  await ingestMessage(gmail(msg()), 'k1', 'ongoing', { resolve: publicResolve, fetchImpl: apiFetch(answer()) });
  const [it] = listItems({ messageId: 'k1' });
  assert.equal(it.state, 'queued');
  assert.equal(it.attachmentName, 'kvish6-2260-000001.pdf');
  assert.ok(notes(it.id).includes('made_from_vendor_data:kvish6'));
});

test('retry of an item with no document reads the email again: found -> new item, placeholder dismissed', async () => {
  const g = gmail(msg());
  await ingestMessage(g, 'k1', 'ongoing', { resolve: publicResolve, fetchImpl: apiFetch(answer({ IsLinkExpired: true })) });
  const [ph] = listItems({ messageId: 'k1' });
  assert.equal(ph.state, 'needs_attention');
  assert.equal(ph.reason, 'link_failed');
  assert.equal(getItemPdf(ph.id), null);

  // Still failing: stays where it was, with the new failure on its history.
  const miss = await refetchItem(g, ph.id, { resolve: publicResolve, fetchImpl: apiFetch(answer({ IsLinkExpired: true })) });
  assert.equal(miss.found, 0);
  assert.equal(getItem(ph.id)!.state, 'needs_attention');
  assert.ok(notes(ph.id).some((n) => (n ?? '').startsWith('manual_retry: link_failed')));

  const hit = await refetchItem(g, ph.id, { resolve: publicResolve, fetchImpl: apiFetch(answer()) });
  assert.equal(hit.found, 1);
  assert.equal(getItem(ph.id)!.state, 'dismissed');
  const live = listItems({ messageId: 'k1' }).filter((i) => i.state !== 'dismissed');
  assert.equal(live.length, 1);
  assert.equal(live[0].state, 'queued');
  assert.equal(live[0].hasPdf, true);
});
