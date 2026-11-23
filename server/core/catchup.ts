import { basename } from 'node:path';
import type { MorningMatch } from '../destinations/morning.js';
import { getDb } from '../db.js';
import type { Settings } from '../settings.js';
import { getItem, getItemPdf, noteItem, updateItem, type Item } from './items.js';
import { getVendor } from './recipeStore.js';
import type { Deps, ExtractedFields } from './types.js';
import { AccountingRejected, TransientError } from './types.js';

/**
 * Catch-up send: documents that were filed but never went to accounting because they came from the first import
 * (the pipeline books only new mail) or because Morning was not connected yet. The owner reviews them, the app
 * checks Morning for each one, and only what Morning does not hold yet is sent, as a draft like any other.
 */

/** The done-event notes that mean "filed, deliberately not sent". */
const NOT_SENT_NOTES = ['backfill_no_accounting', 'accounting_not_configured'] as const;
export type CatchupWhy = 'backfill' | 'not_configured';
const NOTE_IN_MORNING = 'catchup_in_morning';
const NOTE_SKIPPED = 'catchup_skipped';
const NOTE_SENT = 'catchup_sent';

export interface CatchupRow {
  id: string; vendor: string | null; docNumber: string | null; issueDate: string | null; total: number | null;
  currency: string | null; category: string | null; filename: string | null; why: CatchupWhy;
}

export interface Lookup { find(f: ExtractedFields): Promise<MorningMatch> }

/** Why an item is a candidate, or null when it is not one (sent, decided, or the pipeline would not send it). */
function candidateWhy(item: Item, settings: Settings): CatchupWhy | null {
  if (item.state !== 'done' || item.accountingRef || !item.storagePath || !item.fields || !item.vendorKey) return null;
  if (getVendor(item.vendorKey)?.status !== 'business') return null;
  if (!settings.categories.find((c) => c.name === item.fields!.category)?.sendToAccounting) return null;
  const notes = getDb().prepare('SELECT note FROM item_events WHERE item_id = ? AND note IS NOT NULL ORDER BY id')
    .pluck().all(item.id) as string[];
  if (notes.some((n) => n === NOTE_IN_MORNING || n === NOTE_SKIPPED || n.startsWith(NOTE_SENT))) return null;
  const last = [...notes].reverse().find((n) => (NOT_SENT_NOTES as readonly string[]).includes(n));
  return last === 'backfill_no_accounting' ? 'backfill' : last === 'accounting_not_configured' ? 'not_configured' : null;
}

export function listCatchup(settings: Settings): CatchupRow[] {
  const ids = getDb().prepare(
    `SELECT DISTINCT i.id FROM items i JOIN item_events e ON e.item_id = i.id
     WHERE i.state = 'done' AND i.accounting_ref IS NULL AND e.to_state = 'done'
       AND e.note IN (${NOT_SENT_NOTES.map(() => '?').join(',')})`).pluck().all(...NOT_SENT_NOTES) as string[];
  const rows: CatchupRow[] = [];
  for (const id of ids) {
    const item = getItem(id);
    const why = item && candidateWhy(item, settings);
    if (!item || !why) continue;
    const f = item.fields!;
    rows.push({
      id, vendor: f.vendorName, docNumber: f.docNumber, issueDate: f.issueDate, total: f.total, currency: f.currency,
      category: f.category, filename: item.storagePath ? basename(item.storagePath) : item.attachmentName, why,
    });
  }
  return rows.sort((a, b) => (b.issueDate ?? '').localeCompare(a.issueDate ?? ''));
}

/** Candidates only, in the order given; anything else is silently left out. */
function candidates(ids: string[], settings: Settings): Item[] {
  return [...new Set(ids)].map((id) => getItem(id)).filter((i): i is Item => !!i && candidateWhy(i, settings) !== null);
}

export type CheckResult = MorningMatch & { id: string; error?: string };

/** Asks Morning about each document. Read-only. A failed lookup is reported per document, not thrown. */
export async function checkCatchup(ids: string[], settings: Settings, lookup: Lookup): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const item of candidates(ids, settings)) {
    try {
      out.push({ id: item.id, ...(await lookup.find(item.fields!)) });
    } catch (e) {
      out.push({ id: item.id, status: 'unknown', error: (e as Error).message });
    }
  }
  return out;
}

export interface SendResult { id: string; outcome: 'sent' | 'in_morning' | 'failed'; error?: string; match?: MorningMatch }

/**
 * Sends the chosen documents. Each is looked up again right before sending (Morning may have changed since the
 * check): one Morning already holds is not sent but recorded as in Morning. A "maybe" the owner chose is sent.
 * A lookup that fails stops that document, since sending blind could create a duplicate.
 */
export async function sendCatchup(ids: string[], deps: Deps, lookup: Lookup | null): Promise<SendResult[]> {
  if (!deps.accounting) throw new AccountingRejected('accounting_not_configured');
  const out: SendResult[] = [];
  for (const item of candidates(ids, deps.settings)) {
    const fields = item.fields!;
    if (lookup) {
      let match: MorningMatch;
      try { match = await lookup.find(fields); } catch (e) {
        out.push({ id: item.id, outcome: 'failed', error: (e as Error).message });
        continue;
      }
      if (match.status === 'found') {
        markInMorning(item.id, match);
        out.push({ id: item.id, outcome: 'in_morning', match });
        continue;
      }
    }
    const pdf = getItemPdf(item.id);
    const category = deps.settings.categories.find((c) => c.name === fields.category)!;
    if (!pdf) { out.push({ id: item.id, outcome: 'failed', error: 'no pdf' }); continue; }
    try {
      const res = await deps.accounting.send({ pdf, filename: basename(item.storagePath!), fields, category });
      getDb().transaction(() => {
        updateItem(item.id, { accountingRef: res.ref, accountingMode: res.mode });
        noteItem(item.id, `${NOTE_SENT}:${res.mode}`);
      })();
      out.push({ id: item.id, outcome: 'sent' });
    } catch (e) {
      const transient = e instanceof TransientError;
      out.push({ id: item.id, outcome: 'failed', error: transient ? `${(e as Error).message} (try again)` : (e as Error).message });
    }
  }
  return out;
}

function markInMorning(id: string, match: Pick<MorningMatch, 'where' | 'morningId'>): void {
  getDb().transaction(() => {
    if (match.morningId) updateItem(id, { accountingRef: `${match.where ?? 'expense'}:${match.morningId}`, accountingMode: 'existing' });
    noteItem(id, NOTE_IN_MORNING);
  })();
}

/**
 * The owner's own decision: "already in Morning" (entered by hand, or a match they confirmed) or "don't send".
 * Either way the document leaves the list. Returns how many changed.
 */
export function markCatchup(ids: string[], as: 'in_morning' | 'skipped', settings: Settings, refs: Record<string, { where: 'expense' | 'draft'; morningId: string }> = {}): number {
  const items = candidates(ids, settings);
  for (const item of items) {
    if (as === 'in_morning') markInMorning(item.id, refs[item.id] ?? {});
    else noteItem(item.id, NOTE_SKIPPED);
  }
  return items.length;
}
