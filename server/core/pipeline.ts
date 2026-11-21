import { getDb } from '../db.js';
import { getSettings, type Settings } from '../settings.js';
import { AiUnavailableError, aiExtract, aiWriteRecipe } from '../ai/provider.js';
import { findInvoiceForReceipt, findReceiptsForInvoice, markReceiptFor, findReceiptForSentInvoice, sha256 } from './dedupe.js';
import {
  getEmail, getItem, getItemPdf, isUploadId, noteItem, setItemFields, setItemText, setItemVendor, transition, transitionIf,
  updateItem,
  type Item,
} from './items.js';
import { buildFilename, buildFolder } from './naming.js';
import { PdfError, extractPdfText } from './pdfText.js';
import { matchesRecipe, runRecipe, type Recipe } from './recipe.js';
import { findRecipe, getActiveRecipe, getVendor, saveRecipe, setVendorStatus, upsertVendor, type VendorStatus } from './recipeStore.js';
import { TransientError } from './types.js';
import type { Deps, ExtractedFields, ItemState, Provenance, Reason } from './types.js';
import { validateFields, type Problem } from './validate.js';

/** Storage/accounting transient failures allowed before the item goes to needs_attention. */
const MAX_ATTEMPTS = 5;
/** AI waits are uncapped, except this many for one item while the AI succeeded for others since its first wait. */
const MAX_AI_WAITS_WHILE_AI_WORKS = 4;
const MAX_BACKOFF_MIN = 360;
/** Highest `_N` suffix tried when a different file already holds the name. */
const MAX_SUFFIX = 20;

/** Items currently inside processItem in this process; a second concurrent call returns without acting. */
const inFlight = new Set<string>();

type Step = (item: Item, deps: Deps) => Promise<void>;

const STEPS: Partial<Record<ItemState, { run: Step; failReason: Reason }>> = {
  queued: { run: analyze, failReason: 'internal_error' },
  waiting_ai: { run: analyze, failReason: 'internal_error' },
  ready: { run: store, failReason: 'storage_error' },
  stored: { run: account, failReason: 'accounting_error' },
};

/**
 * Runs an item from its current state to the next waiting or terminal state (spec §4.1) and returns it.
 * Every step is recorded before the next starts, so calling it again after a crash resumes where it stopped.
 * It does not look at next_attempt_at: the worker decides when a retry is due.
 * Only database errors escape; any other failure puts the item in needs_attention with the message as note.
 */
export async function processItem(id: string, deps: Deps): Promise<ItemState> {
  if (inFlight.has(id)) return currentState(id);
  inFlight.add(id);
  try {
    for (;;) {
      const item = getItem(id);
      if (!item) throw new Error(`Unknown item: ${id}`);
      const step = STEPS[item.state];
      if (!step) return item.state;
      try {
        await step.run(item, deps);
      } catch (e) {
        if (isDbError(e)) throw e;
        if (currentState(id) === item.state) moveTo(id, 'needs_attention', step.failReason, message(e));
      }
      const after = currentState(id);
      if (after === item.state || after === 'waiting_ai') return after; // waiting for a retry
    }
  } finally {
    inFlight.delete(id);
  }
}

/**
 * Records the user's decision on a vendor and moves its `awaiting_vendor` items on: ignored → `ignored`;
 * business/personal → continue after the vendor step (backfill approval or filing). Returns the touched item ids.
 */
export async function setVendorDecision(vendorKey: string, status: VendorStatus, deps: Deps): Promise<string[]> {
  if (!getVendor(vendorKey)) throw new Error(`Unknown vendor: ${vendorKey}`);
  setVendorStatus(vendorKey, status);
  if (status === 'unreviewed') return [];
  const ids = getDb()
    .prepare(`SELECT id FROM items WHERE state = 'awaiting_vendor' AND vendor_key = ? ORDER BY created_at, rowid`)
    .pluck().all(vendorKey) as string[];
  for (const id of ids) {
    if (status === 'ignored') { moveTo(id, 'ignored', undefined, 'vendor_ignored'); continue; }
    afterVendorStep(id);
    await processItem(id, deps);
  }
  return ids;
}

/** States in which an item's fields are not final yet (nothing filed under them). */
const UNSETTLED: ItemState[] = ['needs_attention', 'awaiting_vendor', 'awaiting_backfill_approval', 'ready'];

/**
 * After the owner changed a vendor's recipe: reads the vendor's not-yet-filed documents again with it, so the
 * documents imported before the fix show what the new recipe reads. Recipe only (no AI, no tokens, no recipe
 * rewrite). Skipped: documents the owner corrected by hand, ones the recipe does not match, and ones it still
 * reads wrong (their previous fields stay). A fixed document that waited for a fix moves on as a hand-fixed one
 * would. Returns how many were checked and how many got new fields.
 */
export function reapplyVendorRecipe(vendorKey: string, settings: Settings, now: Date): { checked: number; updated: number } {
  const recipe = getActiveRecipe(vendorKey);
  if (!recipe || recipe.aiAlways) return { checked: 0, updated: 0 };
  const ids = getDb().prepare(
    `SELECT id FROM items WHERE vendor_key = ? AND state IN (${UNSETTLED.map(() => '?').join(',')})
       AND storage_path IS NULL AND text IS NOT NULL AND COALESCE(provenance, '') != 'manual'
       AND NOT (state = 'needs_attention' AND COALESCE(reason, '') IN ('storage_error', 'accounting_error'))
     ORDER BY created_at, rowid`,
  ).pluck().all(vendorKey, ...UNSETTLED) as string[];
  let checked = 0;
  let updated = 0;
  for (const id of ids) {
    const r = readAgainWith(id, recipe, settings, now);
    if (r.outcome === 'updated' || r.outcome === 'same' || r.outcome === 'invalid') checked++;
    if (r.outcome === 'updated') updated++;
  }
  return { checked, updated };
}

export type ReparseOutcome = 'updated' | 'same' | 'invalid' | 'no_recipe' | 'ai_always' | 'no_match' | 'not_editable' | 'busy';

/**
 * The owner asks to read one not-yet-filed document again with its vendor's current recipe (or, for a document
 * with no vendor yet, the recipe that matches it). Like reapplyVendorRecipe, but it also overrides fields the
 * owner typed by hand: pressing the button says the recipe's reading is wanted. Recipe only, no AI.
 */
export function reparseItem(id: string, settings: Settings, now: Date): { outcome: ReparseOutcome; problems: Problem[] } {
  const item = getItem(id);
  if (!item) throw new Error(`Unknown item: ${id}`);
  if (!UNSETTLED.includes(item.state) || item.storagePath || !item.text) return { outcome: 'not_editable', problems: [] };
  let recipe: Recipe | null = item.vendorKey ? getActiveRecipe(item.vendorKey) : null;
  if (!recipe && !item.vendorKey) {
    const sender = isUploadId(item.messageId) ? '' : bareAddress(getEmail(item.messageId)?.sender ?? '');
    recipe = findRecipe(sender, item.text);
  }
  if (!recipe) return { outcome: 'no_recipe', problems: [] };
  if (recipe.aiAlways) return { outcome: 'ai_always', problems: [] };
  return readAgainWith(id, recipe, settings, now);
}

/** Reads one unsettled document with `recipe`; new valid fields replace the old ones and the item moves on. */
function readAgainWith(id: string, recipe: Recipe, settings: Settings, now: Date): { outcome: ReparseOutcome; problems: Problem[] } {
  if (inFlight.has(id)) return { outcome: 'busy', problems: [] };
  const item = getItem(id);
  if (!item?.text || !UNSETTLED.includes(item.state)) return { outcome: 'not_editable', problems: [] };
  const sender = isUploadId(item.messageId) ? '' : bareAddress(getEmail(item.messageId)?.sender ?? '');
  if (!matchesRecipe(recipe, sender, item.text)) return { outcome: 'no_match', problems: [] };
  const vendorKey = recipe.vendorKey;
  const today = localDate({ settings, now: () => now } as Deps);
  const names = new Set(settings.categories.map((c) => c.name));
  const read = runRecipe(recipe, item.text);
  const vendor = getVendor(vendorKey);
  const category = read.category && names.has(read.category) ? read.category
    : item.fields?.category && names.has(item.fields.category) ? item.fields.category
      : vendor?.defaultCategory && names.has(vendor.defaultCategory) ? vendor.defaultCategory : null;
  const fields: ExtractedFields = { ...read, category };
  const check = validateFields(fields, settings, today);
  if (!check.ok) return { outcome: 'invalid', problems: check.problems };
  const { vatConfirmed: _v, ...before } = item.fields ?? ({} as ExtractedFields);
  void _v;
  if (JSON.stringify(before) === JSON.stringify(fields) && item.vendorKey === vendorKey) {
    return { outcome: 'same', problems: [] };
  }
  if (!item.vendorKey) setItemVendor(id, vendorKey);
  setItemFields(id, fields, 'recipe');
  if (currentState(id) === 'dismissed') return { outcome: 'updated', problems: [] }; // the new doc number is one already on file
  noteItem(id, 'recipe_reapplied');
  if (settleReceiptPair(id, vendorKey, fields, item.text)) return { outcome: 'updated', problems: [] };
  if (item.state !== 'needs_attention' || !category) return { outcome: 'updated', problems: [] };
  const email = getEmail(item.messageId);
  if (vendor?.status === 'ignored') moveTo(id, 'ignored', undefined, 'vendor_ignored');
  else if (!vendor || vendor.status === 'unreviewed') moveTo(id, 'awaiting_vendor', 'new_vendor', 'recipe_reapplied');
  else moveTo(id, email?.mode === 'backfill' ? 'awaiting_backfill_approval' : 'ready', undefined, 'recipe_reapplied');
  return { outcome: 'updated', problems: [] };
}

/**
 * Vendor identity for a document no recipe matched: `tax-<digits>` when a tax id is present, else a slug of
 * an ASCII name, else `v-<hash>` of the whitespace-normalized name (so distinct non-Latin names never merge).
 */
export function vendorKeyFor(f: ExtractedFields): string | null {
  const digits = (f.vendorTaxId ?? '').replace(/\D/g, '');
  if (digits.length >= 2) return `tax-${digits}`.slice(0, 60);
  const name = (f.vendorName ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (name === '') return null;
  if (/^[\x20-\x7e]+$/.test(name)) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 60).replace(/-+$/, '');
    if (slug.length >= 2) return slug;
  }
  return `v-${sha256(Buffer.from(name.toLowerCase())).slice(0, 12)}`;
}

// ---------- steps ----------

/** queued / waiting_ai: text, vendor, fields, category, vendor decision, backfill gate. */
async function analyze(item: Item, deps: Deps): Promise<void> {
  const { settings, ai } = deps;
  const pdf = getItemPdf(item.id);
  if (!pdf) return moveTo(item.id, 'needs_attention', 'unreadable_pdf', 'no pdf');

  let doc: { text: string; isScan: boolean };
  try {
    doc = await (deps.extractText ?? extractPdfText)(pdf);
  } catch (e) {
    if (e instanceof PdfError) return moveTo(item.id, 'needs_attention', 'unreadable_pdf', e.message);
    throw e;
  }
  setItemText(item.id, doc.text);
  if (doc.isScan && !ai) return moveTo(item.id, 'needs_attention', 'unreadable_pdf', 'scanned pdf, no ai');
  if (doc.isScan && !ai?.supportsPdf) return moveTo(item.id, 'needs_attention', 'scan_needs_api_ai');

  // An uploaded document has no sender: only text markers can match a recipe to it.
  const uploaded = isUploadId(item.messageId);
  const sender = uploaded ? '' : bareAddress(getEmail(item.messageId)?.sender ?? '');
  const today = localDate(deps);
  let recipe = findRecipe(sender, doc.text);

  let vendorKey: string | null = null;
  let displayName = '';
  let fields: ExtractedFields | null = null;
  let provenance: Provenance = 'recipe';
  let recipeFailed = false;
  let writeRecipe = false;

  if (recipe) {
    vendorKey = recipe.vendorKey;
    displayName = recipe.displayName;
    ensureVendor(vendorKey, displayName);
    if (getVendor(vendorKey)?.status === 'ignored') {
      setItemVendor(item.id, vendorKey);
      return moveTo(item.id, 'ignored', undefined, 'vendor_ignored');
    }
    if (!recipe.aiAlways) {
      const f = runRecipe(recipe, doc.text);
      const v = validateFields(f, settings, today);
      if (v.ok) fields = f;
      else {
        recipeFailed = true;
        writeRecipe = true;
        if (!ai) {
          // Keep what the recipe found so the user can correct it.
          record(item.id, vendorKey, f, 'recipe', true);
          if (currentState(item.id) === 'dismissed') return;
          return moveTo(item.id, 'needs_attention', v.problems[0], `recipe: ${v.problems.join(',')}`);
        }
      }
    }
  }

  if (!fields) {
    if (!ai) return moveTo(item.id, 'needs_attention', 'no_recipe_no_ai');
    try {
      fields = await aiExtract(
        ai, { text: doc.text, pdf, isScan: doc.isScan, sender, categories: settings.categories.map((c) => c.name) },
        { purpose: 'extract', itemId: item.id },
      );
    } catch (e) {
      if (isDbError(e)) throw e;
      if (e instanceof AiUnavailableError) return waitForAi(item, deps, e.message);
      return moveTo(item.id, 'needs_attention', 'ai_failed', message(e));
    }
    provenance = 'ai';
    if (recipe && recipeVendorDiffers(recipe, fields)) {
      // The recipe matched another vendor's document: the AI's vendor is the right one, and that recipe is
      // neither credited with the document nor rewritten from it.
      noteItem(item.id, `recipe_vendor_mismatch:${recipe.vendorKey}`);
      recipe = null;
      recipeFailed = false;
    }
    if (!recipe) {
      vendorKey = vendorKeyFor(fields);
      displayName = (fields.vendorName ?? vendorKey ?? '').trim().slice(0, 100);
      writeRecipe = true;
    }
  }

  if (vendorKey) ensureVendor(vendorKey, displayName);
  const vendor = vendorKey ? getVendor(vendorKey) : null;

  // Category: as extracted when configured, else the vendor's default.
  const names = new Set(settings.categories.map((c) => c.name));
  const category = fields.category !== null && names.has(fields.category) ? fields.category
    : vendor?.defaultCategory && names.has(vendor.defaultCategory) ? vendor.defaultCategory : null;
  if (category) fields = { ...fields, category };

  record(item.id, vendorKey, fields, provenance, recipeFailed);
  if (currentState(item.id) === 'dismissed') return; // same vendor + doc number already on file

  if (vendor?.status === 'ignored') return moveTo(item.id, 'ignored', undefined, 'vendor_ignored');

  const v = validateFields(fields, settings, today);
  if (!v.ok) return moveTo(item.id, 'needs_attention', v.problems[0], v.problems.join(','));

  // A vendor that sends a tax invoice and later a receipt for it: the invoice is the expense, the receipt is
  // neither filed nor booked (and no recipe is written from it, which would replace the invoice layout's).
  if (vendorKey && settleReceiptPair(item.id, vendorKey, fields, doc.text)) return;

  // A photographed receipt has no text and no sender, so there is nothing a recipe could match or read.
  if (writeRecipe && ai && vendorKey && !(uploaded && doc.isScan)) {
    await writeAiRecipe(item.id, ai, {
      text: doc.text, sender, fields, vendorKey, displayName,
      // No-match path: an existing vendor (e.g. a new sender address) keeps what its recipe already knows.
      ...(recipe ? { failed: recipe } : { existing: getActiveRecipe(vendorKey) ?? undefined }),
    });
  }

  if (!category) return moveTo(item.id, 'needs_attention', 'unknown_category', fields.category ?? undefined);
  if (!vendor || vendor.status === 'unreviewed') return moveTo(item.id, 'awaiting_vendor', 'new_vendor');
  afterVendorStep(item.id);
}

/** ready → stored. Never uploads twice: a recorded path is reused, and same-content files are not re-sent. */
async function store(item: Item, deps: Deps): Promise<void> {
  // Never file without a vendor decision (the edit that names the vendor routes it through the vendor step).
  if (!item.vendorKey) return moveTo(item.id, 'needs_attention', 'missing_vendor', 'no vendor decision');
  const vendor = getVendor(item.vendorKey);
  if (vendor?.status === 'unreviewed') return moveTo(item.id, 'awaiting_vendor', 'new_vendor');
  if (vendor?.status === 'ignored') return moveTo(item.id, 'ignored', undefined, 'vendor_ignored');
  if (item.storagePath) return moveTo(item.id, 'stored', undefined, 'storage_path_recorded');
  const pdf = getItemPdf(item.id);
  if (!pdf || !item.fields) return moveTo(item.id, 'needs_attention', 'storage_error', 'no pdf or fields');
  let folder: string;
  let filename: string;
  try {
    folder = buildFolder(item.fields, deps.settings);
    filename = buildFilename(item.fields, deps.settings);
  } catch (e) {
    return moveTo(item.id, 'needs_attention', 'storage_error', message(e));
  }

  let path: string | null = null;
  let note: string | undefined;
  try {
    for (let n = 1; n <= MAX_SUFFIX && path === null; n++) {
      const name = n === 1 ? filename : filename.replace(/\.pdf$/, `_${n}.pdf`);
      const ex = await deps.storage.exists(folder, name, pdf);
      if (ex.exists && ex.sameContent) { path = joinPath(folder, name); note = 'already_in_storage'; }
      else if (!ex.exists) {
        // R17: put never overwrites; existed=true means someone else took the name first → next _N.
        const r = await deps.storage.put(folder, name, pdf);
        if (!r.existed) path = r.path;
      }
    }
  } catch (e) {
    if (isDbError(e)) throw e;
    if (e instanceof TransientError) return retryLater(item, deps, 'storage_error', e.message);
    return moveTo(item.id, 'needs_attention', 'storage_error', message(e));
  }
  if (path === null) return moveTo(item.id, 'needs_attention', 'storage_error', `no free filename up to _${MAX_SUFFIX}`);
  const filed = path;
  getDb().transaction(() => {
    updateItem(item.id, { storagePath: filed });
    // Dismissed (or otherwise moved) during the upload: the user's decision stands; the filing is recorded.
    moveIf(item.id, 'ready', 'stored', note);
  })();
}

/** stored → done. Sends to accounting only for a business vendor, a sendToAccounting category, a non-backfill
 *  email, a configured destination, and a document that is not the receipt of an invoice already sent. */
async function account(item: Item, deps: Deps): Promise<void> {
  if (item.accountingRef) return finishDone(item, 'accounting_ref_recorded');
  const fields = item.fields;
  if (!fields || !item.vendorKey) return moveTo(item.id, 'needs_attention', 'accounting_error', 'no fields or vendor');
  const vendor = getVendor(item.vendorKey);
  const category = deps.settings.categories.find((c) => c.name === fields.category);
  if (!vendor) return moveTo(item.id, 'needs_attention', 'accounting_error', `unknown vendor ${item.vendorKey}`);
  // Vendor reset to unreviewed after filing: ask again rather than finishing unsent (setVendorDecision resumes).
  if (vendor.status === 'unreviewed') return moveTo(item.id, 'awaiting_vendor', 'new_vendor');

  if (getEmail(item.messageId)?.mode === 'backfill') return finishDone(item, 'backfill_no_accounting');
  if (vendor.status !== 'business') return finishDone(item, `vendor_${vendor.status}`);
  if (!category) return moveTo(item.id, 'needs_attention', 'unknown_category', fields.category ?? undefined);
  if (!category.sendToAccounting) return finishDone(item, 'category_not_sent');
  if (!deps.accounting) return finishDone(item, 'accounting_not_configured');

  const invoiceId = findReceiptForSentInvoice(fields, item.vendorKey, item.text ?? undefined);
  if (invoiceId) {
    getDb().transaction(() => {
      markReceiptFor(item.id, invoiceId);
      finishDone(item, 'receipt_for_sent_invoice');
    })();
    return;
  }

  const pdf = getItemPdf(item.id);
  if (!pdf || !item.storagePath) return moveTo(item.id, 'needs_attention', 'accounting_error', 'no pdf or storage path');
  // R16: a previous attempt (transient failure, or a crash mid-send) may have reached the destination.
  const retry = item.attempts > 0 || hasSendAttempt(item.id);
  noteItem(item.id, SEND_ATTEMPT);
  let res: { ref: string; mode: string };
  try {
    res = await deps.accounting.send({ pdf, filename: basename(item.storagePath), fields, category, retry });
  } catch (e) {
    if (isDbError(e)) throw e;
    if (e instanceof TransientError) return retryLater(item, deps, 'accounting_error', e.message);
    // AccountingRejected (the destination's reason is the message) and anything unexpected: no retry.
    return moveTo(item.id, 'needs_attention', 'accounting_error', message(e));
  }
  getDb().transaction(() => {
    updateItem(item.id, { accountingRef: res.ref, accountingMode: res.mode });
    if (moveIf(item.id, 'stored', 'done', `sent:${res.mode}`) && item.recipeFailed) noteItem(item.id, 'recipe_rewritten');
  })();
}

// ---------- helpers ----------

/**
 * Receipt + separate tax invoice for one payment: only the invoice counts. A receipt whose invoice is already on
 * file is set aside (`ignored`) at once; an invoice that arrives after its receipt sets aside the receipt if it was
 * not filed yet (a filed one stays, and the accounting step still refuses to book it twice).
 * Returns true when this item itself was set aside.
 */
function settleReceiptPair(itemId: string, vendorKey: string, fields: ExtractedFields, text: string): boolean {
  if (fields.docType === 'receipt') {
    const invoiceId = findInvoiceForReceipt(fields, vendorKey, text, itemId);
    if (!invoiceId) return false;
    getDb().transaction(() => {
      markReceiptFor(itemId, invoiceId);
      moveTo(itemId, 'ignored', undefined, `receipt_of_invoice:${invoiceId}`);
    })();
    return true;
  }
  if (fields.docType === 'tax_invoice') {
    for (const receiptId of findReceiptsForInvoice(fields, vendorKey, itemId)) {
      if (inFlight.has(receiptId)) continue; // being processed right now: it checks for this invoice itself
      getDb().transaction(() => {
        markReceiptFor(receiptId, itemId);
        moveTo(receiptId, 'ignored', undefined, `receipt_of_invoice:${itemId}`);
      })();
    }
  }
  return false;
}

const digitsOf = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
const nameKey = (s: string | null | undefined) => (s ?? '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const constOf = (r: Recipe, f: 'vendorName' | 'vendorTaxId') => {
  const rule = r.fields[f];
  return rule?.kind === 'const' ? rule.value : null;
};

/**
 * True when AI-extracted fields clearly name another vendor than the recipe's own identity: its key `tax-<id>`
 * or constant tax id, else its constant (printed) vendor name; never what the recipe read from this document,
 * and not the display name (a user-facing label that need not appear on the document). Tax ids decide when both
 * sides have one; otherwise names that share nothing (neither contains the other).
 */
function recipeVendorDiffers(recipe: Recipe, ai: ExtractedFields): boolean {
  const aiTax = digitsOf(ai.vendorTaxId);
  const recipeTax = /^tax-(\d+)$/.exec(recipe.vendorKey)?.[1] ?? digitsOf(constOf(recipe, 'vendorTaxId'));
  if (aiTax.length >= 5 && recipeTax.length >= 5) return aiTax !== recipeTax;
  const aiName = nameKey(ai.vendorName);
  const recipeName = nameKey(constOf(recipe, 'vendorName'));
  if (!aiName || !recipeName) return false;
  return !recipeName.includes(aiName) && !aiName.includes(recipeName);
}

const SEND_ATTEMPT = 'accounting_send_attempt';

function hasSendAttempt(id: string): boolean {
  return getDb().prepare('SELECT 1 FROM item_events WHERE item_id = ? AND note = ? LIMIT 1').get(id, SEND_ATTEMPT) !== undefined;
}

/** Transition that also clears the retry counters (every state change starts a fresh retry budget). */
function moveTo(id: string, to: ItemState, reason?: Reason, note?: string): void {
  getDb().transaction(() => {
    updateItem(id, { attempts: 0, nextAttemptAt: null });
    transition(id, to, reason, note);
  })();
}

/**
 * moveTo guarded on the state the step started from: if the item moved meanwhile (the user dismissed it during an
 * upload or send), the new state stands and the step's outcome is only noted.
 */
function moveIf(id: string, from: ItemState, to: ItemState, note?: string): boolean {
  return getDb().transaction(() => {
    if (transitionIf(id, from, to, undefined, note)) {
      updateItem(id, { attempts: 0, nextAttemptAt: null });
      return true;
    }
    noteItem(id, `${note ?? to} not applied: item is ${currentState(id)}`);
    return false;
  })();
}

function finishDone(item: Item, note: string): void {
  getDb().transaction(() => {
    moveTo(item.id, 'done', undefined, note);
    if (item.recipeFailed) noteItem(item.id, 'recipe_rewritten');
  })();
}

/** After step 5 (vendor approved): already-filed items go on to accounting; backfill items wait for approval;
 *  the rest are filed. */
function afterVendorStep(id: string): void {
  const item = getItem(id);
  if (item?.storagePath) return moveTo(id, 'stored');
  const email = getEmail(item?.messageId ?? '');
  moveTo(id, email?.mode === 'backfill' ? 'awaiting_backfill_approval' : 'ready');
}

function backoff(deps: Deps, attempts: number): string {
  const minutes = Math.min(2 ** attempts, MAX_BACKOFF_MIN);
  return new Date(deps.now().getTime() + minutes * 60_000).toISOString();
}

/** When the AI went on working for other documents after this item started waiting. */
function aiWorkedSinceFirstWait(id: string): boolean {
  const last = getSettings().lastAiSuccessAt;
  if (!last) return false;
  const since = getDb().prepare(
    `SELECT at FROM item_events WHERE item_id = ? AND to_state = 'waiting_ai'
       AND (from_state IS NULL OR from_state != 'waiting_ai') ORDER BY id DESC LIMIT 1`).pluck().get(id) as string | undefined;
  return since !== undefined && new Date(last).getTime() > new Date(since).getTime();
}

function waitForAi(item: Item, deps: Deps, msg: string): void {
  const attempts = item.attempts + 1;
  // AI waits are uncapped while the AI is down for everyone; one document the AI keeps failing on
  // (while it works for others) is handed to the user instead of waiting forever.
  if (item.state === 'waiting_ai' && attempts >= MAX_AI_WAITS_WHILE_AI_WORKS && aiWorkedSinceFirstWait(item.id)) {
    return moveTo(item.id, 'needs_attention', 'ai_failed', `${msg} (after ${attempts} waits; AI worked for other documents)`);
  }
  getDb().transaction(() => {
    if (item.state !== 'waiting_ai') transition(item.id, 'waiting_ai', undefined, msg);
    updateItem(item.id, { attempts, nextAttemptAt: backoff(deps, attempts) });
  })();
}

function retryLater(item: Item, deps: Deps, reason: Reason, msg: string): void {
  const attempts = item.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) return moveTo(item.id, 'needs_attention', reason, `${msg} (after ${attempts} attempts)`);
  getDb().transaction(() => {
    updateItem(item.id, { attempts, nextAttemptAt: backoff(deps, attempts) });
    noteItem(item.id, `retry ${attempts}: ${msg}`);
  })();
}

function record(id: string, vendorKey: string | null, f: ExtractedFields, p: Provenance, recipeFailed: boolean): void {
  if (vendorKey) setItemVendor(id, vendorKey);
  setItemFields(id, f, p);
  if (recipeFailed) updateItem(id, { recipeFailed: true });
}

function ensureVendor(key: string, displayName: string): void {
  if (!getVendor(key)) upsertVendor(key, displayName || key);
}

/**
 * Asks the AI for a recipe for this layout and saves it under our vendor key. Failure is noted, not fatal.
 * - `failed`: the vendor's recipe matched this document but its result failed validation. The new version
 *   gets new fields but keeps the old match, which is proven to select this vendor's documents.
 * - `existing`: no recipe matched, but the vendor already has one (new sender address). The new version keeps
 *   the old senders and aiAlways; if the AI could not write reproducing fields (aiAlways fallback) the old,
 *   working fields are kept and only the new sender is added.
 */
async function writeAiRecipe(
  itemId: string, ai: NonNullable<Deps['ai']>,
  i: {
    text: string; sender: string; fields: ExtractedFields; vendorKey: string; displayName: string;
    failed?: Recipe; existing?: Recipe;
  },
): Promise<void> {
  const previous = i.failed ?? i.existing;
  try {
    const r = await aiWriteRecipe(ai, { text: i.text, sender: i.sender, fields: i.fields, previous }, { purpose: 'recipe', itemId });
    let next: Recipe;
    if (i.failed) next = { ...r, match: i.failed.match };
    else if (i.existing) {
      const match = mergeMatch(i.existing, r);
      if (!match) return noteItem(itemId, 'recipe_not_merged: existing recipe kept');
      const base = r.aiAlways && !i.existing.aiAlways ? i.existing : r;
      next = withAiAlways({ ...base, match }, !!(i.existing.aiAlways || base.aiAlways));
    } else next = r;
    saveRecipe({ ...next, vendorKey: i.vendorKey, displayName: previous?.displayName ?? i.displayName }, 'ai');
  } catch (e) {
    if (isDbError(e)) throw e;
    noteItem(itemId, `recipe_write_failed: ${message(e)}`);
  }
}

/**
 * A match that selects every document either recipe selected. Senders are alternatives, so they are united
 * (only when both recipes have senders; a sender list on one side would narrow the other). Text markers are
 * all required, so only markers both recipes require are kept. Null when nothing would be left to match on.
 */
function mergeMatch(prev: Recipe, next: Recipe): Recipe['match'] | null {
  const ps = prev.match.senders ?? [];
  const ns = next.match.senders ?? [];
  const senders = ps.length > 0 && ns.length > 0 ? [...new Set([...ns, ...ps])].slice(0, 10) : [];
  const nm = new Set(next.match.textMarkers ?? []);
  const textMarkers = (prev.match.textMarkers ?? []).filter((m) => nm.has(m));
  if (senders.length + textMarkers.length === 0) return null;
  return { ...(senders.length ? { senders } : {}), ...(textMarkers.length ? { textMarkers } : {}) };
}

function withAiAlways(r: Recipe, on: boolean): Recipe {
  const { aiAlways: _drop, ...rest } = r;
  void _drop;
  return on ? { ...rest, aiAlways: true } : rest;
}

function currentState(id: string): ItemState {
  const s = getDb().prepare('SELECT state FROM items WHERE id = ?').pluck().get(id) as ItemState | undefined;
  if (!s) throw new Error(`Unknown item: ${id}`);
  return s;
}

/** 'Name <A@B.co>' → 'a@b.co'. */
function bareAddress(s: string): string {
  const m = /<([^<>]+)>/.exec(s);
  return (m?.[1] ?? s).trim().toLowerCase();
}

/**
 * Today as YYYY-MM-DD for date validation, from deps.now(). Uses `settings.timezone` when present (added by a
 * later task), otherwise the server's local time zone.
 */
function localDate(deps: Deps): string {
  const tz = (deps.settings as { timezone?: string }).timezone;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(deps.now());
}

const joinPath = (folder: string, name: string) => (folder.endsWith('/') ? `${folder}${name}` : `${folder}/${name}`);
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isDbError = (e: unknown) => e instanceof Error && e.name === 'SqliteError';
