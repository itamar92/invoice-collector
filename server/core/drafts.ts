import { basename } from 'node:path';
import type { ApproveInput, ApproveResult, PendingDraft } from '../destinations/morning.js';
import { ApproveBlocked } from '../destinations/morning.js';
import { getDb } from '../db.js';
import type { Settings } from '../settings.js';
import { getItem, getItemPdf, noteItem, updateItem, type Item } from './items.js';
import type { ExtractedFields } from './types.js';

/**
 * "Waiting for approval in Morning": the drafts in the owner's Morning approval queue, each tied to the document of
 * ours it came from (when it did), so the owner sees Morning's reading next to ours and can approve with our details.
 */

export interface DraftsSource {
  listPending(): Promise<PendingDraft[]>;
  approve(input: ApproveInput): Promise<ApproveResult>;
}

/** ref: our upload's key or a recorded draft id; found: same number, amount and supplier; maybe: two of three. */
export type DraftMatch = 'ref' | 'found' | 'maybe';

export interface DraftRow {
  draft: PendingDraft;
  item: null | {
    id: string; fields: ExtractedFields; filename: string | null;
    /** The category's Morning classification id; null = not mapped in Settings, so approving is not possible. */
    classificationId: string | null;
  };
  match: DraftMatch | null;
}

const digits = (s: unknown) => (typeof s === 'string' || typeof s === 'number' ? String(s).replace(/\D/g, '') : '');
const normName = (s: unknown) => (typeof s === 'string' ? s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') : '');
const normNumber = (s: unknown) =>
  typeof s === 'string' || typeof s === 'number' ? String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').replace(/^0+(?=\d)/, '') : '';

/** Documents we sent to Morning that are not known to be approved expenses there. */
function sentItems(): Item[] {
  const ids = getDb().prepare(
    `SELECT id FROM items WHERE accounting_ref IS NOT NULL AND accounting_ref NOT LIKE 'expense:%'
       AND (accounting_mode IS NULL OR accounting_mode <> 'email') ORDER BY created_at DESC LIMIT 5000`).pluck().all() as string[];
  return ids.map((id) => getItem(id)).filter((i): i is Item => !!i && !!i.fields);
}

function byRef(d: PendingDraft, ref: string): boolean {
  if (ref === `draft:${d.id}` || ref === d.id) return true;
  // An upload's ref is its S3 object key (date/business/filename): the draft's file key or link carries it.
  if (!ref.includes('/')) return false;
  if (d.fileKey && (d.fileKey === ref || ref.endsWith(d.fileKey) || d.fileKey.endsWith(ref))) return true;
  if (!d.fileUrl) return false;
  let url = d.fileUrl;
  try { url = decodeURIComponent(d.fileUrl); } catch { /* keep raw */ }
  return url.includes(ref);
}

function compare(d: PendingDraft, f: ExtractedFields): 'found' | 'maybe' | null {
  const ours = normNumber(f.docNumber);
  const num = ours !== '' && normNumber(d.number) === ours;
  const amount = d.amount !== null && f.total !== null && Math.abs(d.amount - f.total) <= 0.01;
  const supplier = (digits(d.supplierTaxId) !== '' && digits(d.supplierTaxId) === digits(f.vendorTaxId))
    || (normName(d.supplierName) !== '' && normName(d.supplierName) === normName(f.vendorName));
  if (num && amount && supplier) return 'found';
  if (num && (amount || supplier)) return 'maybe';
  if (ours === '' && amount && supplier && !!f.issueDate && d.date === f.issueDate) return 'maybe';
  return null;
}

/** Each pending draft with the document it came from. A document is tied to one draft at most; surest ties first. */
export function matchDrafts(drafts: PendingDraft[], settings: Settings, items: Item[] = sentItems()): DraftRow[] {
  const taken = new Set<string>();
  const tie = new Map<string, { item: Item; match: DraftMatch }>();
  const pass = (match: DraftMatch, test: (d: PendingDraft, i: Item) => boolean) => {
    for (const d of drafts) {
      if (tie.has(d.id)) continue;
      const hit = items.find((i) => !taken.has(i.id) && test(d, i));
      if (hit) { taken.add(hit.id); tie.set(d.id, { item: hit, match }); }
    }
  };
  pass('ref', (d, i) => byRef(d, i.accountingRef!));
  pass('found', (d, i) => compare(d, i.fields!) === 'found');
  pass('maybe', (d, i) => compare(d, i.fields!) === 'maybe');
  return drafts.map((draft) => {
    const t = tie.get(draft.id);
    if (!t) return { draft, item: null, match: null };
    const f = t.item.fields!;
    const cls = settings.categories.find((c) => c.name === f.category)?.accountingClassification ?? null;
    return {
      draft, match: t.match,
      item: { id: t.item.id, fields: f, filename: t.item.storagePath ? basename(t.item.storagePath) : t.item.attachmentName, classificationId: cls || null },
    };
  });
}

export class ApproveError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}

/**
 * Approves one draft with our document's details. The draft must still be pending in Morning (looked up again now)
 * and the document's category must be mapped to a Morning classification. Records the expense on the document.
 */
export async function approveDraft(draftId: string, itemId: string, settings: Settings, src: DraftsSource): Promise<ApproveResult> {
  const item = getItem(itemId);
  if (!item?.fields) throw new ApproveError('item_not_found', 404);
  if (item.accountingRef?.startsWith('expense:')) throw new ApproveError('already_approved');
  const draft = (await src.listPending()).find((d) => d.id === draftId);
  if (!draft) throw new ApproveError('draft_gone', 404);
  const cls = settings.categories.find((c) => c.name === item.fields!.category)?.accountingClassification;
  if (!cls) throw new ApproveError('no_classification');
  let res: ApproveResult;
  try {
    res = await src.approve({
      draft, fields: item.fields, classificationId: cls, pdf: getItemPdf(item.id),
      filename: item.storagePath ? basename(item.storagePath) : item.attachmentName ?? 'document.pdf',
    });
  } catch (e) {
    if (e instanceof ApproveBlocked) throw new ApproveError(e.code);
    throw e;
  }
  getDb().transaction(() => {
    updateItem(item.id, { accountingRef: `expense:${res.expenseId}` });
    noteItem(item.id, `morning_approved: expense=${res.expenseId}${res.existed ? ' (existed)' : ''}; file=${res.fileAttached ? 'attached' : 'no'}; draft=${res.draftRemoved ? 'removed' : `kept${res.draftReason ? ` (${res.draftReason})` : ''}`}`);
  })();
  return res;
}
