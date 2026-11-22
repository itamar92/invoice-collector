import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectDb, openDb, getDb, runAsTenant } from '../server/db.js';
import { openAccounts } from '../server/accounts.js';
import { findShared, sharedStats, useSharedRecipes, withdrawShared } from '../server/core/sharedRecipes.js';
import { createEmail, createItem, getItem, transition, updateItem } from '../server/core/items.js';
import {
  getVendor, publishOwnRecipes, recipeHistory, saveRecipe, setVendorCategory, setVendorStatus, type VendorStatus,
} from '../server/core/recipeStore.js';
import { PdfError } from '../server/core/pdfText.js';
import type { Recipe } from '../server/core/recipe.js';
import {
  AccountingRejected, TransientError, type AccountingDestination, type Deps, type ExtractedFields,
  type StorageDestination,
} from '../server/core/types.js';
import { AiOutputError, AiUnavailableError, type AiProvider, type AiRequest } from '../server/ai/provider.js';
import { EXTRACT_SYSTEM, RECIPE_SYSTEM } from '../server/ai/prompts.js';
import { IL_DEFAULTS } from '../server/defaults/il.js';
import { updateSettings } from '../server/settings.js';
import { processItem, reapplyVendorRecipe, reparseItem, setVendorDecision, vendorKeyFor } from '../server/core/pipeline.js';
import { itemUsage, usageSummary } from '../server/ai/usage.js';

// ---------- synthetic documents ----------

const NOW = new Date('2026-06-15T09:00:00Z');
const SETTINGS = { ...IL_DEFAULTS, storageRoot: '/Inv' };

function invoiceText(o: { vendor?: string; num?: string; date?: string; total?: string; kind?: string } = {}): string {
  return [
    o.vendor ?? 'Demo Widgets Ltd', `${o.kind ?? 'Invoice'} ${o.num ?? '1001'}`,
    `Date: ${o.date ?? '05/06/2026'}`, `Total: ${o.total ?? '117.00'}`,
  ].join('\n');
}
const pdfOf = (text: string) => Buffer.from(`%PDF-synthetic\n${text}`);

/** Fake text extraction: the "PDF" is a marker line plus text. Empty text = scan; 'BROKEN' = unreadable. */
async function fakeExtract(pdf: Buffer) {
  const text = pdf.toString('utf8').replace(/^%PDF-synthetic\n/, '');
  if (text.startsWith('BROKEN')) throw new PdfError('unreadable_pdf', 'unreadable PDF: synthetic');
  return { text, pages: 1, isScan: text.trim() === '' };
}

/** Starter-style recipe for the synthetic layout. */
function layoutRecipe(vendorKey: string, sender: string, over: Partial<Recipe> = {}): Recipe {
  return {
    schemaVersion: 1, vendorKey, displayName: `Vendor ${vendorKey}`, match: { senders: [sender] },
    fields: {
      vendorName: { kind: 'regex', pattern: '^(.+)$', flags: 'm', parse: 'text' },
      docType: { kind: 'const', value: 'tax_invoice' },
      docNumber: { kind: 'regex', pattern: 'Invoice (\\d+)', parse: 'text' },
      issueDate: { kind: 'regex', pattern: 'Date: (\\d{2}/\\d{2}/\\d{4})', parse: 'date', dateFormat: 'DD/MM/YYYY' },
      total: { kind: 'regex', pattern: 'Total: ([\\d.,]+)', parse: 'amount' },
      currency: { kind: 'const', value: 'ILS' },
    },
    ...over,
  };
}

function knownVendor(key: string, sender: string, status: VendorStatus, category = 'תוכנה', over: Partial<Recipe> = {}) {
  saveRecipe(layoutRecipe(key, sender, over), 'starter');
  setVendorStatus(key, status);
  setVendorCategory(key, category);
}

// ---------- fakes ----------

function fakeStorage(seed: Record<string, Buffer> = {}) {
  const files = new Map<string, Buffer>(Object.entries(seed));
  const s = {
    files, puts: 0, existsCalls: 0, failTimes: 0, failWith: null as Error | null,
    async exists(folder: string, filename: string, pdf: Buffer) {
      s.existsCalls++;
      if (s.failTimes > 0) { s.failTimes--; throw s.failWith ?? new TransientError('storage 503'); }
      const f = files.get(`${folder}/${filename}`);
      return { exists: !!f, sameContent: !!f && f.equals(pdf) };
    },
    async put(folder: string, filename: string, pdf: Buffer) {
      s.puts++;
      const path = `${folder}/${filename}`;
      const existed = files.has(path);
      files.set(path, pdf);
      return { path, existed };
    },
  };
  return s satisfies StorageDestination;
}

function fakeAccounting() {
  const a = {
    calls: [] as Parameters<AccountingDestination['send']>[0][],
    failWith: null as Error | null, failTimes: 0,
    async send(item: Parameters<AccountingDestination['send']>[0]) {
      if (a.failTimes > 0) { a.failTimes--; throw a.failWith ?? new TransientError('accounting 503'); }
      a.calls.push(item);
      return { ref: `acc-${a.calls.length}`, mode: 'api_fields' as const };
    },
  };
  return a;
}

/** AI fake: extraction reads the synthetic layout; recipe writing returns layoutRecipe with a junk vendorKey. */
function fakeAi(o: { supportsPdf?: boolean; pdfOnlyForScans?: boolean; category?: string | null } = {}) {
  const ai = {
    name: 'fake', supportsPdf: o.supportsPdf ?? true, pdfOnlyForScans: o.pdfOnlyForScans,
    extractCalls: 0, recipeCalls: 0, requests: [] as AiRequest[],
    unavailable: false, outputError: false, overrideFields: null as Partial<ExtractedFields> | null,
    async completeJson(req: AiRequest): Promise<unknown> {
      ai.requests.push(req);
      if (ai.unavailable) throw new AiUnavailableError('ai down');
      if (ai.outputError) throw new AiOutputError('garbage');
      const text = /<invoice_text>\n([\s\S]*)\n<\/invoice_text>/.exec(req.user)?.[1] ?? '';
      const sender = /<sender>(.*)<\/sender>/.exec(req.user)?.[1] ?? '';
      if (req.system === EXTRACT_SYSTEM) {
        ai.extractCalls++;
        const lines = text.split('\n');
        const [d, m, y] = (/Date: (\d{2})\/(\d{2})\/(\d{4})/.exec(text) ?? []).slice(1);
        return {
          vendorName: lines[0] ?? null, vendorTaxId: null,
          docType: /^Receipt/m.test(text) ? 'receipt' : 'tax_invoice',
          docNumber: /(?:Invoice|Receipt) (\d+)/.exec(text)?.[1] ?? null,
          issueDate: y ? `${y}-${m}-${d}` : null,
          total: Number(/Total: ([\d.]+)/.exec(text)?.[1] ?? 'NaN') || null,
          vat: null, net: null, currency: 'ILS', allocationNumber: null, description: 'widgets',
          category: o.category === undefined ? 'תוכנה' : o.category,
          ...ai.overrideFields,
        };
      }
      if (req.system === RECIPE_SYSTEM) {
        ai.recipeCalls++;
        return layoutRecipe('whatever-the-ai-said', sender, { fields: { ...layoutRecipe('x', sender).fields, category: { kind: 'const', value: 'תוכנה' } } });
      }
      throw new Error('unexpected prompt');
    },
    async ping() {},
  };
  return ai satisfies AiProvider;
}

function deps(o: { storage?: StorageDestination; accounting?: AccountingDestination | null; ai?: AiProvider | null; settings?: typeof SETTINGS } = {}): Deps {
  return {
    storage: o.storage ?? fakeStorage(), accounting: o.accounting === undefined ? fakeAccounting() : o.accounting,
    ai: o.ai === undefined ? null : o.ai, settings: o.settings ?? SETTINGS, now: () => NOW, extractText: fakeExtract,
  };
}

let seq = 0;
function newItem(text: string, o: { sender?: string; mode?: 'ongoing' | 'backfill' | 'manual' } = {}) {
  const messageId = `m${++seq}`;
  createEmail({
    messageId, threadId: `t${seq}`, sender: o.sender ?? 'Billing <billing@acme.example>', subject: 's',
    receivedAt: '2026-06-05T10:00:00Z', mode: o.mode ?? 'ongoing',
  });
  const pdf = pdfOf(text);
  const { id } = createItem(messageId, 'a.pdf', pdf);
  return { id, pdf };
}

const notes = (id: string) =>
  (getDb().prepare('SELECT note FROM item_events WHERE item_id = ? ORDER BY id').pluck().all(id) as (string | null)[])
    .filter((n): n is string => n !== null);

beforeEach(() => {
  openDb(join(mkdtempSync(join(tmpdir(), 'ic-pipe-')), 't.db'));
});

// ---------- brief Step 1 ----------

test('known vendor (starter recipe, business) → done; storage once, accounting once', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const { id, pdf } = newItem(invoiceText());
  const st = fakeStorage(); const acc = fakeAccounting();
  const state = await processItem(id, deps({ storage: st, accounting: acc }));
  assert.equal(state, 'done');
  assert.equal(st.puts, 1);
  assert.equal(acc.calls.length, 1);
  const it = getItem(id)!;
  assert.equal(it.provenance, 'recipe');
  assert.equal(it.vendorKey, 'acme');
  assert.equal(it.fields?.category, 'תוכנה');
  assert.equal(it.storagePath, '/Inv/2026/תוכנה/2026-06-05_חשבונית מס_Demo Widgets Ltd_117_שח.pdf');
  assert.equal(it.accountingRef, 'acc-1');
  assert.equal(it.accountingMode, 'api_fields');
  assert.equal(acc.calls[0]!.filename, '2026-06-05_חשבונית מס_Demo Widgets Ltd_117_שח.pdf');
  assert.equal(acc.calls[0]!.category.name, 'תוכנה');
  assert.ok(acc.calls[0]!.pdf.equals(pdf));
  assert.ok(st.files.get(it.storagePath!)!.equals(pdf));
});

test('personal vendor → done, stored, accounting not called', async () => {
  knownVendor('acme', 'billing@acme.example', 'personal');
  const { id, pdf } = newItem(invoiceText());
  const st = fakeStorage(); const acc = fakeAccounting();
  assert.equal(await processItem(id, deps({ storage: st, accounting: acc })), 'done');
  assert.equal(st.puts, 1);
  assert.equal(acc.calls.length, 0);
  assert.ok(notes(id).includes('vendor_personal'));
});

test('category set not to send → not sent; תרומות → sent', async () => {
  const settings = { ...SETTINGS, categories: SETTINGS.categories.map(c => c.name === 'עלויות אחרות' ? { ...c, sendToAccounting: false } : c) };
  knownVendor('med', 'billing@med.example', 'business', 'עלויות אחרות');
  knownVendor('don', 'billing@don.example', 'business', 'תרומות');
  const acc = fakeAccounting();
  const a = newItem(invoiceText(), { sender: 'billing@med.example' });
  const b = newItem(invoiceText({ num: '2002' }), { sender: 'billing@don.example' });
  assert.equal(await processItem(a.id, deps({ accounting: acc, settings })), 'done');
  assert.equal(acc.calls.length, 0);
  assert.ok(notes(a.id).includes('category_not_sent'));
  assert.equal(await processItem(b.id, deps({ accounting: acc, settings })), 'done');
  assert.equal(acc.calls.length, 1);
  assert.equal(acc.calls[0]!.category.name, 'תרומות');
});

test('unknown vendor + AI → recipe saved (source ai, our vendorKey); second invoice uses the recipe', async () => {
  const ai = fakeAi();
  const acc = fakeAccounting();
  const first = newItem(invoiceText());
  assert.equal(await processItem(first.id, deps({ ai, accounting: acc })), 'awaiting_vendor');
  const it = getItem(first.id)!;
  assert.equal(it.reason, 'new_vendor');
  assert.equal(it.provenance, 'ai');
  assert.equal(it.vendorKey, 'demo-widgets-ltd');
  assert.equal(ai.extractCalls, 1);
  assert.equal(ai.recipeCalls, 1);
  const hist = recipeHistory('demo-widgets-ltd');
  assert.equal(hist.length, 1);
  assert.equal(hist[0]!.source, 'ai');
  assert.equal(recipeHistory('whatever-the-ai-said').length, 0);
  assert.equal(getVendor('demo-widgets-ltd')?.status, 'unreviewed');

  // Vendor decision resumes the waiting item from the step after the vendor check.
  const touched = await setVendorDecision('demo-widgets-ltd', 'business', deps({ ai, accounting: acc }));
  assert.deepEqual(touched, [first.id]);
  assert.equal(getItem(first.id)!.state, 'done');
  assert.equal(acc.calls.length, 1);
  assert.equal(ai.extractCalls, 1, 'decision does not re-extract');

  const second = newItem(invoiceText({ num: '1002', date: '10/06/2026', total: '234.00' }));
  assert.equal(await processItem(second.id, deps({ ai, accounting: acc })), 'done');
  assert.equal(getItem(second.id)!.provenance, 'recipe');
  assert.equal(getItem(second.id)!.vendorKey, 'demo-widgets-ltd');
  assert.equal(ai.extractCalls, 1);
  assert.equal(ai.recipeCalls, 1);
  assert.equal(acc.calls.length, 2);
});

test('AiUnavailableError → waiting_ai with next_attempt_at; resumes when AI is back', async () => {
  const ai = fakeAi();
  ai.unavailable = true;
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ ai })), 'waiting_ai');
  let it = getItem(id)!;
  assert.equal(it.attempts, 1);
  assert.equal(it.nextAttemptAt, new Date(NOW.getTime() + 2 * 60_000).toISOString());
  assert.equal(await processItem(id, deps({ ai })), 'waiting_ai');
  it = getItem(id)!;
  assert.equal(it.attempts, 2);
  assert.equal(it.nextAttemptAt, new Date(NOW.getTime() + 4 * 60_000).toISOString());
  ai.unavailable = false;
  assert.equal(await processItem(id, deps({ ai })), 'awaiting_vendor');
  it = getItem(id)!;
  assert.equal(it.attempts, 0);
  assert.equal(it.nextAttemptAt, null);
});

test('AI waits are not capped at 5 attempts; backoff caps at 360 minutes', async () => {
  const ai = fakeAi();
  ai.unavailable = true;
  const { id } = newItem(invoiceText());
  updateItem(id, { attempts: 11 });
  transition(id, 'waiting_ai');
  assert.equal(await processItem(id, deps({ ai })), 'waiting_ai');
  assert.equal(getItem(id)!.attempts, 12);
  assert.equal(getItem(id)!.nextAttemptAt, new Date(NOW.getTime() + 360 * 60_000).toISOString());
});

test('AI unavailable for this item only: after 4 waits while AI succeeded since the first wait → ai_failed', async () => {
  const ai = fakeAi();
  ai.unavailable = true;
  const { id } = newItem(invoiceText());
  for (let i = 1; i <= 3; i++) assert.equal(await processItem(id, deps({ ai })), 'waiting_ai');
  // Another document was AI-extracted after this item started waiting.
  updateSettings({ lastAiSuccessAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(await processItem(id, deps({ ai })), 'needs_attention');
  assert.equal(getItem(id)!.reason, 'ai_failed');
});

test('AI down for everyone: waits stay uncapped even past 4 when no AI success since the first wait', async () => {
  const ai = fakeAi();
  ai.unavailable = true;
  const { id } = newItem(invoiceText());
  updateSettings({ lastAiSuccessAt: new Date(Date.now() - 86_400_000).toISOString() });
  for (let i = 1; i <= 6; i++) assert.equal(await processItem(id, deps({ ai })), 'waiting_ai');
});

test('no AI + unknown vendor → needs_attention/no_recipe_no_ai', async () => {
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ ai: null })), 'needs_attention');
  assert.equal(getItem(id)!.reason, 'no_recipe_no_ai');
});

test('crash resume: item in stored → accounting only, storage put count 0', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const { id, pdf } = newItem(invoiceText());
  const acc = fakeAccounting();
  acc.failTimes = 1;
  assert.equal(await processItem(id, deps({ accounting: acc })), 'stored');
  assert.equal(getItem(id)!.attempts, 1);
  const st2 = fakeStorage();
  assert.equal(await processItem(id, deps({ storage: st2, accounting: acc })), 'done');
  assert.equal(st2.puts, 0);
  assert.equal(st2.existsCalls, 0);
  assert.equal(acc.calls.length, 1);
});

test('crash resume: ready with storage_path recorded → no upload', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const { id } = newItem(invoiceText());
  const st = fakeStorage();
  st.failTimes = 1;
  assert.equal(await processItem(id, deps({ storage: st })), 'ready');
  updateItem(id, { storagePath: '/Inv/x.pdf' }); // as if put succeeded and the process died before 'stored'
  const st2 = fakeStorage();
  assert.equal(await processItem(id, deps({ storage: st2 })), 'done');
  assert.equal(st2.puts, 0);
  assert.equal(getItem(id)!.storagePath, '/Inv/x.pdf');
});

test('crash resume: stored with accounting_ref recorded → not sent again', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const { id } = newItem(invoiceText());
  const acc = fakeAccounting();
  acc.failTimes = 1;
  assert.equal(await processItem(id, deps({ accounting: acc })), 'stored');
  updateItem(id, { accountingRef: 'acc-earlier', accountingMode: 'email' });
  assert.equal(await processItem(id, deps({ accounting: acc })), 'done');
  assert.equal(acc.calls.length, 0);
  assert.equal(getItem(id)!.accountingRef, 'acc-earlier');
});

test('storage exists with same content → no upload, path reused', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const { id, pdf } = newItem(invoiceText());
  const path = '/Inv/2026/תוכנה/2026-06-05_חשבונית מס_Demo Widgets Ltd_117_שח.pdf';
  const st = fakeStorage({ [path]: pdf });
  assert.equal(await processItem(id, deps({ storage: st })), 'done');
  assert.equal(st.puts, 0);
  assert.equal(getItem(id)!.storagePath, path);
});

test('storage exists with different content → filename _2, then _3', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const { id, pdf } = newItem(invoiceText());
  const base = '/Inv/2026/תוכנה/2026-06-05_חשבונית מס_Demo Widgets Ltd_117_שח';
  const st = fakeStorage({ [`${base}.pdf`]: Buffer.from('other') });
  assert.equal(await processItem(id, deps({ storage: st })), 'done');
  assert.equal(st.puts, 1);
  assert.equal(getItem(id)!.storagePath, `${base}_2.pdf`);
  assert.ok(getItem(id)!.storagePath!.endsWith('_2.pdf'));

  const b = newItem(invoiceText({ num: '1003' }));
  const st2 = fakeStorage({ [`${base}.pdf`]: Buffer.from('x'), [`${base}_2.pdf`]: Buffer.from('y') });
  assert.equal(await processItem(b.id, deps({ storage: st2 })), 'done');
  assert.equal(getItem(b.id)!.storagePath, `${base}_3.pdf`);
});

test('every suffix up to _20 taken → needs_attention/storage_error', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const { id, pdf } = newItem(invoiceText());
  const base = '/Inv/2026/תוכנה/2026-06-05_חשבונית מס_Demo Widgets Ltd_117_שח';
  const seed: Record<string, Buffer> = { [`${base}.pdf`]: Buffer.from('o') };
  for (let n = 2; n <= 20; n++) seed[`${base}_${n}.pdf`] = Buffer.from('o');
  const st = fakeStorage(seed);
  assert.equal(await processItem(id, deps({ storage: st })), 'needs_attention');
  assert.equal(getItem(id)!.reason, 'storage_error');
  assert.equal(st.puts, 0);
});

test('receipt after a sent invoice → set aside: not filed, not sent', async () => {
  knownVendor('acme', 'billing@acme.example', 'business', 'תוכנה', {
    fields: {
      ...layoutRecipe('acme', 'x').fields,
      docType: { kind: 'regex', pattern: '^(Tax Invoice|Receipt) ', flags: 'm', parse: 'docType' },
      docNumber: { kind: 'regex', pattern: '(?:Invoice|Receipt) (\\d+)', parse: 'text' },
    },
  });
  const acc = fakeAccounting();
  const inv = newItem(invoiceText({ kind: 'Tax Invoice' }));
  assert.equal(await processItem(inv.id, deps({ accounting: acc })), 'done');
  assert.equal(getItem(inv.id)!.fields?.docType, 'tax_invoice');
  assert.equal(acc.calls.length, 1);

  const st = fakeStorage();
  const rec = newItem(invoiceText({ kind: 'Receipt', num: '5001', date: '12/06/2026' }));
  assert.equal(await processItem(rec.id, deps({ storage: st, accounting: acc })), 'ignored');
  assert.equal(getItem(rec.id)!.fields?.docType, 'receipt');
  assert.equal(acc.calls.length, 1);
  assert.equal(st.puts, 0);
  assert.ok(notes(rec.id).includes(`receipt_for:${inv.id}`));
  assert.ok(notes(rec.id).includes(`receipt_of_invoice:${inv.id}`));
});

test('backfill email → awaiting_backfill_approval; after approval stored, accounting never called', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const { id } = newItem(invoiceText(), { mode: 'backfill' });
  const st = fakeStorage(); const acc = fakeAccounting();
  assert.equal(await processItem(id, deps({ storage: st, accounting: acc })), 'awaiting_backfill_approval');
  assert.equal(await processItem(id, deps({ storage: st, accounting: acc })), 'awaiting_backfill_approval');
  assert.equal(st.puts, 0);
  transition(id, 'ready'); // approval (Task 14)
  assert.equal(await processItem(id, deps({ storage: st, accounting: acc })), 'done');
  assert.equal(st.puts, 1);
  assert.equal(acc.calls.length, 0);
  assert.ok(notes(id).includes('backfill_no_accounting'));
});

test('storage fails 5 times → needs_attention/storage_error, with backoff in between', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const { id } = newItem(invoiceText());
  const st = fakeStorage();
  st.failTimes = 99;
  const acc = fakeAccounting();
  for (let n = 1; n <= 4; n++) {
    assert.equal(await processItem(id, deps({ storage: st, accounting: acc })), 'ready');
    assert.equal(getItem(id)!.attempts, n);
    assert.equal(getItem(id)!.nextAttemptAt, new Date(NOW.getTime() + 2 ** n * 60_000).toISOString());
  }
  assert.equal(await processItem(id, deps({ storage: st, accounting: acc })), 'needs_attention');
  assert.equal(getItem(id)!.reason, 'storage_error');
  assert.equal(st.existsCalls, 5);
  assert.equal(st.puts, 0);
  assert.equal(acc.calls.length, 0);
});

// ---------- further rules ----------

test('recipe result fails validation → AI fallback, recipe rewritten (new version), done with recipe_rewritten', async () => {
  // The starter recipe reads the wrong total pattern on this layout → missing_total.
  knownVendor('acme', 'billing@acme.example', 'business', 'תוכנה', {
    fields: { ...layoutRecipe('acme', 'x').fields, total: { kind: 'regex', pattern: 'Sum: ([\\d.,]+)', parse: 'amount' } },
  });
  const ai = fakeAi();
  const acc = fakeAccounting();
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ ai, accounting: acc })), 'done');
  const it = getItem(id)!;
  assert.equal(it.recipeFailed, true);
  assert.equal(it.provenance, 'ai');
  assert.equal(it.vendorKey, 'acme');
  assert.equal(it.fields?.total, 117);
  assert.ok(notes(id).includes('recipe_rewritten'));
  const hist = recipeHistory('acme');
  assert.equal(hist.length, 2);
  assert.equal(hist[0]!.source, 'ai');
  assert.equal(hist[0]!.recipe.displayName, 'Vendor acme');
  assert.equal(acc.calls.length, 1);
  const prompt = ai.requests.find((r) => r.system === RECIPE_SYSTEM)!.user;
  assert.match(prompt, /Sum:/, 'previous recipe is passed to the rewrite');
});

test('recipe matched another vendor\'s document: AI names a different tax id → AI vendor, recipe not rewritten', async () => {
  // Marker-only recipe of vendor A (tax id 511111111) whose total pattern does not fit vendor B's document.
  saveRecipe(layoutRecipe('vendor-a', 'x', {
    match: { textMarkers: ['Total:'] },
    fields: {
      ...layoutRecipe('vendor-a', 'x').fields,
      vendorName: { kind: 'const', value: 'Vendor A Ltd' }, vendorTaxId: { kind: 'const', value: '511111111' },
      total: { kind: 'regex', pattern: 'Sum: ([\\d.,]+)', parse: 'amount' },
    },
  }), 'starter');
  setVendorStatus('vendor-a', 'business');
  setVendorCategory('vendor-a', 'תוכנה');
  const ai = fakeAi();
  ai.overrideFields = { vendorName: 'Vendor B Ltd', vendorTaxId: '522222222' };
  const acc = fakeAccounting();
  const { id } = newItem(invoiceText({ vendor: 'Vendor B Ltd' }), { sender: 'b@vendor-b.example' });
  assert.equal(await processItem(id, deps({ ai, accounting: acc })), 'awaiting_vendor');
  assert.equal(getItem(id)!.vendorKey, 'tax-522222222');
  assert.equal(recipeHistory('vendor-a').length, 1, 'vendor A recipe untouched');
  assert.equal(acc.calls.length, 0);
  // No tax id from the AI: the recipe's printed (const) name decides; a clearly different name → AI vendor.
  ai.overrideFields = { vendorName: 'Gamma Supplies', vendorTaxId: null };
  const g = newItem(invoiceText({ vendor: 'Gamma Supplies', num: '3003' }), { sender: 'c@gamma.example' });
  assert.equal(await processItem(g.id, deps({ ai, accounting: acc })), 'awaiting_vendor');
  assert.equal(getItem(g.id)!.vendorKey, 'gamma-supplies');
  // Same vendor spelled with a suffix ("Vendor A Ltd" vs "Vendor A Ltd. (branch)") stays with the recipe.
  ai.overrideFields = { vendorName: 'Vendor A Ltd. (branch)', vendorTaxId: null };
  const a = newItem(invoiceText({ vendor: 'Vendor A Ltd', num: '4004' }), { sender: 'a@vendor-a.example' });
  await processItem(a.id, deps({ ai, accounting: acc }));
  assert.equal(getItem(a.id)!.vendorKey, 'vendor-a');
});

test('recipe fails validation and no AI → needs_attention/<problem>', async () => {
  knownVendor('acme', 'billing@acme.example', 'business', 'תוכנה', {
    fields: { ...layoutRecipe('acme', 'x').fields, total: { kind: 'regex', pattern: 'Sum: ([\\d.,]+)', parse: 'amount' } },
  });
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ ai: null })), 'needs_attention');
  assert.equal(getItem(id)!.reason, 'missing_total');
  assert.equal(getItem(id)!.recipeFailed, true);
});

test('aiAlways recipe → AI extraction every time, no rewrite', async () => {
  knownVendor('acme', 'billing@acme.example', 'business', 'תוכנה', { aiAlways: true });
  const ai = fakeAi();
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ ai })), 'done');
  assert.equal(ai.extractCalls, 1);
  assert.equal(ai.recipeCalls, 0);
  assert.equal(getItem(id)!.provenance, 'ai');
  assert.equal(getItem(id)!.recipeFailed, false);
});

test('ignored vendor → ignored; nothing stored or sent, no AI', async () => {
  knownVendor('acme', 'billing@acme.example', 'ignored');
  const ai = fakeAi(); const st = fakeStorage(); const acc = fakeAccounting();
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ ai, storage: st, accounting: acc })), 'ignored');
  assert.equal(st.puts + st.existsCalls + acc.calls.length + ai.extractCalls, 0);
});

test('AI-identified vendor already ignored → ignored', async () => {
  const ai = fakeAi();
  const { id } = newItem(invoiceText());
  await processItem(id, deps({ ai }));
  await setVendorDecision('demo-widgets-ltd', 'ignored', deps({ ai }));
  assert.equal(getItem(id)!.state, 'ignored');
  // A new invoice from another address of the same vendor (no recipe match) is ignored too.
  const b = newItem(invoiceText({ num: '7' }), { sender: 'other@elsewhere.example' });
  assert.equal(await processItem(b.id, deps({ ai })), 'ignored');
});

test('category: not in settings and no vendor default → needs_attention/unknown_category', async () => {
  const ai = fakeAi({ category: 'Not A Category' });
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ ai })), 'needs_attention');
  assert.equal(getItem(id)!.reason, 'unknown_category');
});

test('category: falls back to vendor default when the extracted one is unknown', async () => {
  knownVendor('acme', 'billing@acme.example', 'business', 'הוצאות דואר ותקשורת', {
    fields: { ...layoutRecipe('acme', 'x').fields, category: { kind: 'const', value: 'nonsense' } },
  });
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps()), 'done');
  assert.equal(getItem(id)!.fields?.category, 'הוצאות דואר ותקשורת');
});

test('scan: no AI → unreadable_pdf; AI without PDF support → scan_needs_api_ai; PDF-capable AI → proceeds', async () => {
  const a = newItem('');
  assert.equal(await processItem(a.id, deps({ ai: null })), 'needs_attention');
  assert.equal(getItem(a.id)!.reason, 'unreadable_pdf');
  const b = newItem(' ');
  assert.equal(await processItem(b.id, deps({ ai: fakeAi({ supportsPdf: false }) })), 'needs_attention');
  assert.equal(getItem(b.id)!.reason, 'scan_needs_api_ai');
  const ai = fakeAi();
  ai.overrideFields = { vendorName: 'Scan Co', docNumber: '9', issueDate: '2026-06-01', total: 50 };
  const c = newItem('  ');
  assert.equal(await processItem(c.id, deps({ ai })), 'awaiting_vendor');
  assert.ok(ai.requests[0]!.pdf, 'PDF sent to the AI');
});

test('a provider that reads files only for scans (ssh + inbox) gets the PDF for a scan, text for a text PDF', async () => {
  const ai = fakeAi({ pdfOnlyForScans: true });
  ai.overrideFields = { vendorName: 'Scan Co', docNumber: '9', issueDate: '2026-06-01', total: 50 };
  const scan = newItem(' ');
  assert.equal(await processItem(scan.id, deps({ ai })), 'awaiting_vendor');
  assert.ok(ai.requests.find((r) => r.system === EXTRACT_SYSTEM)!.pdf, 'scan: PDF sent');
  const text = fakeAi({ pdfOnlyForScans: true });
  const t = newItem(invoiceText());
  await processItem(t.id, deps({ ai: text }));
  const req = text.requests.find((r) => r.system === EXTRACT_SYSTEM)!;
  assert.equal(req.pdf, undefined, 'text PDF: text only');
});

test('unreadable PDF → needs_attention/unreadable_pdf', async () => {
  const { id } = newItem('BROKEN');
  assert.equal(await processItem(id, deps({ ai: fakeAi() })), 'needs_attention');
  assert.equal(getItem(id)!.reason, 'unreadable_pdf');
});

test('AI output error → needs_attention/ai_failed', async () => {
  const ai = fakeAi();
  ai.outputError = true;
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ ai })), 'needs_attention');
  assert.equal(getItem(id)!.reason, 'ai_failed');
});

test('AI result invalid → needs_attention/<problem>, fields kept for editing, no recipe written', async () => {
  const ai = fakeAi();
  ai.overrideFields = { issueDate: '2026-12-01' };
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ ai })), 'needs_attention');
  assert.equal(getItem(id)!.reason, 'future_date');
  assert.equal(getItem(id)!.fields?.issueDate, '2026-12-01');
  assert.equal(ai.recipeCalls, 0);
});

test('recipe writing failure is not fatal: item proceeds, note recorded', async () => {
  const ai = fakeAi();
  const orig = ai.completeJson;
  ai.completeJson = async (req) => {
    if (req.system === RECIPE_SYSTEM) throw new AiUnavailableError('down for recipes');
    return orig(req);
  };
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ ai })), 'awaiting_vendor');
  assert.ok(notes(id).some((n) => n.startsWith('recipe_write_failed')));
  assert.equal(recipeHistory('demo-widgets-ltd').length, 0);
});

test('AccountingRejected → needs_attention/accounting_error immediately with the message', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const acc = fakeAccounting();
  acc.failTimes = 1;
  acc.failWith = new AccountingRejected('supplier tax id invalid');
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ accounting: acc })), 'needs_attention');
  assert.equal(getItem(id)!.reason, 'accounting_error');
  assert.ok(notes(id).includes('supplier tax id invalid'));
  assert.ok(getItem(id)!.storagePath);
});

test('accounting send says retry only after a previous send attempt for this item', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const accounting = fakeAccounting();
  accounting.failTimes = 1;
  const retries: (boolean | undefined)[] = [];
  const send = accounting.send.bind(accounting);
  accounting.send = async (i) => { retries.push(i.retry); return send(i); };
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ accounting })), 'stored'); // transient failure, waits
  assert.equal(await processItem(id, deps({ accounting })), 'done');
  assert.deepEqual(retries, [false, true]);
  // A crash after the send started (attempts still 0) also counts as a previous attempt.
  const second = newItem(invoiceText({ num: '2002' }));
  getDb().prepare(`INSERT INTO item_events (item_id, at, from_state, to_state, note)
                   VALUES (?, '2026-01-01', 'stored', 'stored', 'accounting_send_attempt')`).run(second.id);
  retries.length = 0;
  await processItem(second.id, deps({ accounting }));
  assert.deepEqual(retries, [true]);
});

test('dismissed while the upload is in flight → stays dismissed, path recorded, nothing sent', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const storage = fakeStorage();
  const accounting = fakeAccounting();
  const { id } = newItem(invoiceText());
  const put = storage.put.bind(storage);
  storage.put = async (...a) => { transition(id, 'dismissed', undefined, 'manual_dismiss'); return put(...a); };
  assert.equal(await processItem(id, deps({ storage, accounting })), 'dismissed');
  assert.equal(accounting.calls.length, 0);
  assert.ok(getItem(id)!.storagePath);
  assert.ok(notes(id).some((n) => /not applied.*dismissed/.test(n)));
});

test('dismissed while the accounting send is in flight → stays dismissed, ref recorded', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const accounting = fakeAccounting();
  const { id } = newItem(invoiceText());
  const send = accounting.send.bind(accounting);
  accounting.send = async (i) => { transition(id, 'dismissed', undefined, 'manual_dismiss'); return send(i); };
  assert.equal(await processItem(id, deps({ accounting })), 'dismissed');
  assert.equal(accounting.calls.length, 1);
  assert.equal(getItem(id)!.accountingRef, 'acc-1');
  assert.ok(notes(id).some((n) => /sent:api_fields not applied.*dismissed/.test(n)));
});

test('ready item without a vendor is never filed → needs_attention/missing_vendor', async () => {
  const storage = fakeStorage();
  const { id } = newItem(invoiceText());
  getDb().prepare(`UPDATE items SET fields_json = ?, state = 'ready' WHERE id = ?`).run(JSON.stringify({
    vendorName: 'Demo Widgets Ltd', vendorTaxId: null, docType: 'tax_invoice', docNumber: '1001', issueDate: '2026-06-05',
    total: 117, vat: null, net: null, currency: 'ILS', allocationNumber: null, description: 'x', category: 'תוכנה',
  }), id);
  assert.equal(await processItem(id, deps({ storage })), 'needs_attention');
  assert.equal(getItem(id)!.reason, 'missing_vendor');
  assert.equal(storage.puts, 0);
});

test('accounting fails 5 times → needs_attention/accounting_error', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const acc = fakeAccounting();
  acc.failTimes = 99;
  const { id } = newItem(invoiceText());
  for (let n = 1; n <= 4; n++) assert.equal(await processItem(id, deps({ accounting: acc })), 'stored');
  assert.equal(await processItem(id, deps({ accounting: acc })), 'needs_attention');
  assert.equal(getItem(id)!.reason, 'accounting_error');
});

test('unexpected storage error → needs_attention/storage_error with message, no retry', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const st = fakeStorage();
  st.failTimes = 1;
  st.failWith = new Error('boom');
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ storage: st })), 'needs_attention');
  assert.equal(getItem(id)!.reason, 'storage_error');
  assert.ok(notes(id).includes('boom'));
});

test('accounting not configured → done with note', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ accounting: null })), 'done');
  assert.ok(notes(id).includes('accounting_not_configured'));
});

test('duplicate doc number from the same vendor → dismissed, nothing filed', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const st = fakeStorage();
  const a = newItem(invoiceText());
  const b = newItem(`${invoiceText()}\n(copy)`);
  assert.equal(await processItem(a.id, deps({ storage: st })), 'done');
  assert.equal(await processItem(b.id, deps({ storage: st })), 'dismissed');
  assert.equal(st.puts, 1);
});

test('setVendorDecision: ignored → items ignored; unknown vendor throws', async () => {
  const ai = fakeAi();
  const a = newItem(invoiceText());
  const b = newItem(invoiceText({ num: '1002' }), { sender: 'x@y.example' });
  await processItem(a.id, deps({ ai }));
  await processItem(b.id, deps({ ai }));
  assert.equal(getItem(b.id)!.state, 'awaiting_vendor');
  const touched = await setVendorDecision('demo-widgets-ltd', 'ignored', deps({ ai }));
  assert.deepEqual(new Set(touched), new Set([a.id, b.id]));
  assert.equal(getItem(a.id)!.state, 'ignored');
  assert.equal(getVendor('demo-widgets-ltd')?.status, 'ignored');
  await assert.rejects(setVendorDecision('nope', 'business', deps()), /Unknown vendor/);
});

test('setVendorDecision on a backfill item → awaiting_backfill_approval', async () => {
  const ai = fakeAi();
  const { id } = newItem(invoiceText(), { mode: 'backfill' });
  assert.equal(await processItem(id, deps({ ai })), 'awaiting_vendor');
  await setVendorDecision('demo-widgets-ltd', 'personal', deps({ ai }));
  assert.equal(getItem(id)!.state, 'awaiting_backfill_approval');
});

test('terminal and waiting states are left alone', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const st = fakeStorage();
  const { id } = newItem(invoiceText());
  await processItem(id, deps({ storage: st }));
  assert.equal(await processItem(id, deps({ storage: st })), 'done');
  assert.equal(st.puts, 1);
});

test('concurrent processItem on one item does not double-file', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const st = fakeStorage(); const acc = fakeAccounting();
  const { id } = newItem(invoiceText());
  const d = deps({ storage: st, accounting: acc });
  await Promise.all([processItem(id, d), processItem(id, d)]);
  assert.equal(st.puts, 1);
  assert.equal(acc.calls.length, 1);
});

test('vendorKeyFor: slug, tax id, non-latin names hash', () => {
  const f = (o: Partial<ExtractedFields>) => vendorKeyFor({
    vendorName: null, vendorTaxId: null, docType: null, docNumber: null, issueDate: null, total: null, vat: null,
    net: null, currency: null, allocationNumber: null, description: null, category: null, ...o,
  });
  assert.equal(f({ vendorName: '  Demo  Widgets, Ltd. ' }), 'demo-widgets-ltd');
  assert.equal(f({ vendorName: 'Demo', vendorTaxId: '51-234 5678' }), 'tax-512345678');
  const he1 = f({ vendorName: 'ספק אחד בע"מ' });
  const he2 = f({ vendorName: 'ספק שני בע"מ' });
  assert.match(he1!, /^v-[0-9a-f]{12}$/);
  assert.notEqual(he1, he2);
  assert.equal(f({ vendorName: 'ספק אחד  בע"מ' }), he1, 'whitespace-insensitive');
  assert.equal(f({}), null);
});

// ---------- fix round 1 ----------

test('no-match AI recipe for an existing vendor keeps the old senders: both addresses then match by recipe', async () => {
  // Starter recipe for sender A under the key the AI will derive for this vendor.
  knownVendor('demo-widgets-ltd', 'a@acme.example', 'business');
  const ai = fakeAi();
  const acc = fakeAccounting();
  const b1 = newItem(invoiceText({ num: '1' }), { sender: 'b@other.example' });
  assert.equal(await processItem(b1.id, deps({ ai, accounting: acc })), 'done');
  assert.equal(ai.extractCalls, 1);
  const prompt = ai.requests.find((r) => r.system === RECIPE_SYSTEM)!.user;
  assert.match(prompt, /a@acme\.example/, 'existing recipe passed as previous');
  const active = recipeHistory('demo-widgets-ltd')[0]!;
  assert.equal(active.version, 2);
  assert.deepEqual(new Set(active.recipe.match.senders), new Set(['a@acme.example', 'b@other.example']));

  const a2 = newItem(invoiceText({ num: '2' }), { sender: 'a@acme.example' });
  assert.equal(await processItem(a2.id, deps({ ai, accounting: acc })), 'done');
  const b3 = newItem(invoiceText({ num: '3' }), { sender: 'b@other.example' });
  assert.equal(await processItem(b3.id, deps({ ai, accounting: acc })), 'done');
  assert.equal(getItem(a2.id)!.provenance, 'recipe');
  assert.equal(getItem(b3.id)!.provenance, 'recipe');
  assert.equal(ai.extractCalls, 1, 'no further AI extraction');
});

test('no-match AI recipe that falls back to aiAlways keeps the previous working fields, adds the sender', async () => {
  knownVendor('demo-widgets-ltd', 'a@acme.example', 'business');
  const ai = fakeAi();
  const orig = ai.completeJson;
  ai.completeJson = async (req) => {
    if (req.system === RECIPE_SYSTEM) { ai.recipeCalls++; return layoutRecipe('zz', 'b@other.example', { fields: { total: { kind: 'regex', pattern: 'Nope ([\\d.]+)', parse: 'amount' } } }); }
    return orig(req);
  };
  const b1 = newItem(invoiceText({ num: '1' }), { sender: 'b@other.example' });
  assert.equal(await processItem(b1.id, deps({ ai })), 'done');
  const active = recipeHistory('demo-widgets-ltd')[0]!.recipe;
  assert.notEqual(active.aiAlways, true);
  assert.deepEqual(active.fields, layoutRecipe('demo-widgets-ltd', 'x').fields);
  assert.deepEqual(new Set(active.match.senders), new Set(['a@acme.example', 'b@other.example']));
});

test('no-match AI recipe keeps a user-set aiAlways', async () => {
  knownVendor('demo-widgets-ltd', 'a@acme.example', 'business', 'תוכנה', { aiAlways: true });
  const ai = fakeAi();
  const b1 = newItem(invoiceText({ num: '1' }), { sender: 'b@other.example' });
  assert.equal(await processItem(b1.id, deps({ ai })), 'done');
  const active = recipeHistory('demo-widgets-ltd')[0]!.recipe;
  assert.equal(active.aiAlways, true);
  assert.deepEqual(new Set(active.match.senders), new Set(['a@acme.example', 'b@other.example']));
});

test('vendor back to unreviewed while stored → awaiting_vendor; business then sends once', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const acc = fakeAccounting();
  acc.failTimes = 1;
  const st = fakeStorage();
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ storage: st, accounting: acc })), 'stored');
  setVendorStatus('acme', 'unreviewed');
  assert.equal(await processItem(id, deps({ storage: st, accounting: acc })), 'awaiting_vendor');
  assert.equal(getItem(id)!.reason, 'new_vendor');
  assert.equal(acc.calls.length, 0);
  await setVendorDecision('acme', 'business', deps({ storage: st, accounting: acc }));
  assert.equal(getItem(id)!.state, 'done');
  assert.equal(acc.calls.length, 1);
  assert.equal(st.puts, 1, 'not uploaded again');
});

test('vendor back to unreviewed while ready → awaiting_vendor before filing', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const st = fakeStorage();
  st.failTimes = 1;
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ storage: st })), 'ready');
  setVendorStatus('acme', 'unreviewed');
  assert.equal(await processItem(id, deps({ storage: st })), 'awaiting_vendor');
  assert.equal(st.puts, 0);
});

test('put reporting existed:true is a conflict → next _N name', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const st = fakeStorage();
  let conflicts = 1;
  const realPut = st.put;
  st.put = async (folder, filename, pdf) => {
    if (conflicts-- > 0) { st.puts++; return { path: `${folder}/${filename}`, existed: true }; }
    return realPut(folder, filename, pdf);
  };
  const { id } = newItem(invoiceText());
  assert.equal(await processItem(id, deps({ storage: st })), 'done');
  assert.ok(getItem(id)!.storagePath!.endsWith('_2.pdf'));
  assert.equal(st.puts, 2);
});

test('no-match AI recipe cannot be merged with a marker-only recipe → existing recipe kept, noted', async () => {
  knownVendor('demo-widgets-ltd', 'unused@x.example', 'business', 'תוכנה', { match: { textMarkers: ['ACME-MARK'] } });
  const ai = fakeAi();
  const b1 = newItem(invoiceText({ num: '1' }), { sender: 'b@other.example' });
  assert.equal(await processItem(b1.id, deps({ ai })), 'done');
  assert.equal(recipeHistory('demo-widgets-ltd').length, 1);
  assert.ok(notes(b1.id).some((n) => n.startsWith('recipe_not_merged')));
});

// ---------- receipt + separate tax invoice ----------

/** A layout recipe that tells a tax invoice from a receipt (and reads either number). */
function pairVendor() {
  knownVendor('acme', 'billing@acme.example', 'business', 'תוכנה', {
    fields: {
      ...layoutRecipe('acme', 'x').fields,
      docType: { kind: 'regex', pattern: '^(Tax Invoice|Receipt) ', flags: 'm', parse: 'docType' },
      docNumber: { kind: 'regex', pattern: '(?:Invoice|Receipt) (\\d+)', parse: 'text' },
    },
  });
}

test('first import: receipt read before its invoice is set aside once the invoice arrives (unfiled)', async () => {
  pairVendor();
  const st = fakeStorage();
  const rec = newItem(invoiceText({ kind: 'Receipt', num: '5001', date: '12/06/2026' }), { mode: 'backfill' });
  assert.equal(await processItem(rec.id, deps({ storage: st })), 'awaiting_backfill_approval');
  const inv = newItem(invoiceText({ kind: 'Tax Invoice', num: '1001', date: '05/06/2026' }), { mode: 'backfill' });
  assert.equal(await processItem(inv.id, deps({ storage: st })), 'awaiting_backfill_approval');
  assert.equal(getItem(rec.id)!.state, 'ignored');
  assert.ok(notes(rec.id).includes(`receipt_of_invoice:${inv.id}`));
  // The invoice takes one receipt only: a second receipt of the same amount stays.
  const rec2 = newItem(invoiceText({ kind: 'Receipt', num: '5002', date: '14/06/2026' }), { mode: 'backfill' });
  assert.equal(await processItem(rec2.id, deps({ storage: st })), 'awaiting_backfill_approval');
});

test('receipt for another amount and no invoice number → filed as usual', async () => {
  pairVendor();
  const inv = newItem(invoiceText({ kind: 'Tax Invoice', num: '1001' }));
  assert.equal(await processItem(inv.id, deps()), 'done');
  const rec = newItem(invoiceText({ kind: 'Receipt', num: '5001', date: '12/06/2026', total: '50.00' }));
  assert.equal(await processItem(rec.id, deps()), 'done');
});

test('a receipt naming the invoice number pairs with it even when an amount-only match is nearer', async () => {
  pairVendor();
  const a = newItem(invoiceText({ kind: 'Tax Invoice', num: '1001', date: '01/06/2026' }));
  const b = newItem(invoiceText({ kind: 'Tax Invoice', num: '1002', date: '10/06/2026' }));
  await processItem(a.id, deps()); await processItem(b.id, deps());
  const rec = newItem(`${invoiceText({ kind: 'Receipt', num: '5001', date: '12/06/2026' })}\nPaid for 1001`);
  assert.equal(await processItem(rec.id, deps()), 'ignored');
  assert.ok(notes(rec.id).includes(`receipt_of_invoice:${a.id}`));
});

// ---------- recipe change re-reads the vendor's waiting documents ----------

test('reapplyVendorRecipe: fixed recipe re-reads unfiled documents; hand-fixed and filed ones are left alone', async () => {
  // A recipe that reads the total from the wrong line: every document fails validation (no total).
  knownVendor('acme', 'billing@acme.example', 'business', 'תוכנה', {
    fields: { ...layoutRecipe('acme', 'x').fields, total: { kind: 'regex', pattern: 'Sum: ([\\d.]+)', parse: 'amount' } },
  });
  const a = newItem(invoiceText({ num: '1001' }), { mode: 'backfill' });
  const b = newItem(invoiceText({ num: '1002', total: '200.00' }), { mode: 'backfill' });
  const c = newItem(invoiceText({ num: '1003' }), { mode: 'backfill' });
  for (const x of [a, b, c]) assert.equal(await processItem(x.id, deps()), 'needs_attention');
  // c was corrected by hand: the owner's fields stay.
  getDb().prepare(`UPDATE items SET provenance = 'manual' WHERE id = ?`).run(c.id);

  saveRecipe(layoutRecipe('acme', 'billing@acme.example'), 'user');
  const r = reapplyVendorRecipe('acme', SETTINGS, NOW);
  assert.deepEqual(r, { checked: 2, updated: 2 });
  assert.equal(getItem(a.id)!.state, 'awaiting_backfill_approval');
  assert.equal(getItem(a.id)!.fields?.total, 117);
  assert.equal(getItem(a.id)!.fields?.category, 'תוכנה');
  assert.equal(getItem(b.id)!.fields?.total, 200);
  assert.ok(notes(a.id).includes('recipe_reapplied'));
  assert.equal(getItem(c.id)!.state, 'needs_attention');

  // Same recipe again: nothing new to read.
  assert.deepEqual(reapplyVendorRecipe('acme', SETTINGS, NOW), { checked: 2, updated: 0 });
});

test('reapplyVendorRecipe: a recipe that still reads wrong keeps the previous fields', async () => {
  knownVendor('acme', 'billing@acme.example', 'business');
  const a = newItem(invoiceText(), { mode: 'backfill' });
  assert.equal(await processItem(a.id, deps()), 'awaiting_backfill_approval');
  saveRecipe(layoutRecipe('acme', 'billing@acme.example', {
    fields: { ...layoutRecipe('acme', 'x').fields, total: { kind: 'regex', pattern: 'Nope: ([\\d.]+)', parse: 'amount' } },
  }), 'user');
  assert.deepEqual(reapplyVendorRecipe('acme', SETTINGS, NOW), { checked: 1, updated: 0 });
  assert.equal(getItem(a.id)!.fields?.total, 117);
  assert.equal(getItem(a.id)!.state, 'awaiting_backfill_approval');
});

test('reparseItem: one document re-read with the current recipe, even after a hand edit', async () => {
  knownVendor('acme', 'billing@acme.example', 'business', 'תוכנה', {
    fields: { ...layoutRecipe('acme', 'x').fields, total: { kind: 'regex', pattern: 'Sum: ([\\d.]+)', parse: 'amount' } },
  });
  const a = newItem(invoiceText({ num: '1001' }), { mode: 'backfill' });
  assert.equal(await processItem(a.id, deps()), 'needs_attention');
  getDb().prepare(`UPDATE items SET provenance = 'manual' WHERE id = ?`).run(a.id);
  // The old recipe still reads it wrong.
  assert.equal(reparseItem(a.id, SETTINGS, NOW).outcome, 'invalid');

  saveRecipe(layoutRecipe('acme', 'billing@acme.example'), 'user');
  assert.equal(reparseItem(a.id, SETTINGS, NOW).outcome, 'updated');
  const after = getItem(a.id)!;
  assert.equal(after.fields?.total, 117);
  assert.equal(after.provenance, 'recipe');
  assert.equal(after.state, 'awaiting_backfill_approval');
  assert.equal(reparseItem(a.id, SETTINGS, NOW).outcome, 'same');
});

// ---------- AI token usage ----------

test('AI usage is recorded per document and summed for the first import', async () => {
  const ai = fakeAi();
  const orig = ai.completeJson;
  ai.completeJson = async (req) => {
    req.onUsage?.({ inputTokens: req.system === EXTRACT_SYSTEM ? 1000 : 2000, outputTokens: 100 });
    return orig(req);
  };
  const a = newItem(invoiceText(), { mode: 'backfill' });
  await processItem(a.id, deps({ ai }));
  const u = itemUsage(a.id);
  assert.equal(u.calls, ai.extractCalls + ai.recipeCalls);
  assert.equal(u.inputTokens, 1000 * ai.extractCalls + 2000 * ai.recipeCalls);
  assert.equal(u.outputTokens, 100 * u.calls);
  const sum = usageSummary(NOW);
  assert.deepEqual(sum.backfill, u);
  assert.equal(sum.total.calls, u.calls);
});

// ---------- recipes shared between users ----------

test('shared recipes: one user\'s AI recipe reads another user\'s first document from that vendor, no AI call', async () => {
  useSharedRecipes(openAccounts(':memory:'));
  try {
    const alice = { id: 'alice', db: connectDb(':memory:') };
    const bob = { id: 'bob', db: connectDb(':memory:') };

    // Alice: unknown vendor, AI reads it and writes a recipe, which is published.
    const ai = fakeAi();
    await runAsTenant(alice, async () => {
      const { id } = newItem(invoiceText());
      await processItem(id, deps({ ai }));
      assert.equal(getItem(id)!.provenance, 'ai');
    });
    assert.equal(ai.recipeCalls, 1);
    const shared = findShared('billing@acme.example', invoiceText());
    assert.ok(shared, 'published');
    assert.equal(shared.fields.category, undefined, 'category names are personal and never shared');

    // Bob: same vendor, a different invoice. No AI configured at all, yet it is read by the shared recipe.
    await runAsTenant(bob, async () => {
      const { id } = newItem(invoiceText({ num: '2002', total: '58.50' }));
      await processItem(id, deps({ ai: null }));
      const it = getItem(id)!;
      assert.equal(it.provenance, 'recipe');
      assert.equal(it.fields?.docNumber, '2002');
      assert.equal(it.fields?.total, 58.5);
      assert.equal(it.state, 'needs_attention'); // no category yet: Bob picks his own
      assert.equal(recipeHistory(it.vendorKey!)[0]!.source, 'shared');
      assert.equal(getVendor(it.vendorKey!)!.status, 'unreviewed'); // business/personal stays Bob's decision
    });
    assert.equal(ai.extractCalls, 1, 'Bob used no AI');
    assert.equal(sharedStats().adopted, 1);
    // Bob's copy is a 'shared' recipe: it is not published back.
    assert.equal(sharedStats().recipes, 1);
  } finally { useSharedRecipes(null); }
});

test('shared recipes: a user\'s own recipe for the vendor wins; unsafe or aiAlways recipes are not shared', async () => {
  useSharedRecipes(openAccounts(':memory:'));
  try {
    saveRecipe(layoutRecipe('acme', 'billing@acme.example', { aiAlways: true }), 'ai');
    saveRecipe(layoutRecipe('gm', 'someone@gmail.com'), 'user');
    assert.equal(sharedStats().recipes, 0);
    saveRecipe(layoutRecipe('acme', 'billing@acme.example'), 'user');
    assert.equal(sharedStats().recipes, 1);

    const carol = { id: 'carol', db: connectDb(':memory:') };
    runAsTenant(carol, () => {
      saveRecipe(layoutRecipe('acme', 'old@acme.example', { displayName: 'Carol acme' }), 'starter');
    });
    await runAsTenant(carol, async () => {
      const { id } = newItem(invoiceText());
      await processItem(id, deps({ ai: null }));
      assert.equal(getItem(id)!.reason, 'no_recipe_no_ai'); // her own acme recipe is kept, not replaced
      assert.equal(recipeHistory('acme').length, 1);
    });
  } finally { useSharedRecipes(null); }
});

test('shared recipes: opting out stops sharing and withdraws only this user\'s; opting back in re-offers without overwriting', () => {
  useSharedRecipes(openAccounts(':memory:'));
  try {
    const dana = { id: 'dana', db: connectDb(':memory:') };
    const eli = { id: 'eli', db: connectDb(':memory:') };
    runAsTenant(eli, () => saveRecipe(layoutRecipe('beta', 'billing@beta.example'), 'ai'));
    runAsTenant(dana, () => {
      saveRecipe(layoutRecipe('acme', 'billing@acme.example'), 'ai');
      assert.equal(sharedStats().recipes, 2);

      updateSettings({ shareRecipes: false });
      assert.equal(withdrawShared(), 1); // Dana's acme only
      saveRecipe(layoutRecipe('gamma', 'billing@gamma.example'), 'user');
      assert.equal(findShared('billing@acme.example', invoiceText()), null);
      assert.equal(findShared('billing@gamma.example', invoiceText()), null, 'nothing new is shared while off');
      assert.ok(findShared('billing@beta.example', invoiceText()), 'Eli\'s stays');
    });
    // Meanwhile Eli shares a newer acme recipe.
    runAsTenant(eli, () => saveRecipe(layoutRecipe('acme', 'billing@acme.example', { displayName: 'Eli acme' }), 'ai'));
    runAsTenant(dana, () => {
      updateSettings({ shareRecipes: true });
      publishOwnRecipes();
    });
    assert.ok(findShared('billing@gamma.example', invoiceText()), 're-offered');
    assert.equal(findShared('billing@acme.example', invoiceText())!.displayName, 'Eli acme', 'newer one kept');
  } finally { useSharedRecipes(null); }
});
