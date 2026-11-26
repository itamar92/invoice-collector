import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, ZodError } from 'zod';
import { AiOutputError, AiUnavailableError, aiWriteRecipe, getAiProvider } from './ai/provider.js';
import type { AiProvider } from './ai/provider.js';
import { emptyTotals, itemUsage, usageSummary } from './ai/usage.js';
import { currentUser, requireUser } from './auth.js';
import {
  approveBackfill, BACKFILL_INTERRUPTED, backfillList, finishBackfill, skipBackfill, startBackfill,
} from './core/backfill.js';
import { listIngestFailures } from './core/ingestFailures.js';
import {
  getEmail, getItem, getItemPdf, isUploadId, listItems, ITEM_SORTS, setItemFields, setItemVendor, transition, isTerminal, updateItem,
} from './core/items.js';
import { listMissed, hideMissed, queueMissed } from './core/missed.js';
import { listNotifications, markNotificationsRead, unreadNotifications } from './core/notifications.js';
import { deletePushSubscription, isAllowedEndpoint, savePushSubscription, sendPush, vapidPublicKey } from './push.js';
import { withdrawShared } from './core/sharedRecipes.js';
import { markedEmailIds, resetData } from './core/reset.js';
import { suggestFilter } from './core/labelSuggest.js';
import { suggestOwnTaxIds } from './core/notInvoice.js';
import { reapplyVendorRecipe, reparseItem, setVendorDecision, vendorKeyFor } from './core/pipeline.js';
import { checkRecipe, compileRecipe, RecipeError } from './core/recipe.js';
import {
  getActiveRecipe, getVendor, listVendors, publishOwnRecipes, recipeHistory, saveRecipe, setVendorCategory, setVendorStatus, upsertVendor,
} from './core/recipeStore.js';
import type { Item } from './core/items.js';
import { FolderConflictError, FolderNotFoundError } from './core/types.js';
import type { Deps, ExtractedFields, ItemState } from './core/types.js';
import { validateFields } from './core/validate.js';
import { currentTenantId, getDb } from './db.js';
import { detectMorningModes, fetchMorningClassifications, MorningLookup, type MorningClassification } from './destinations/morning.js';
import { checkCatchup, listCatchup, markCatchup, sendCatchup, type Lookup } from './core/catchup.js';
import { chooseStorage } from './destinations/storage.js';
import { getSecret, secretStatus, SECRET_KEYS, setSecret } from './secrets.js';
import { stats } from './stats.js';
import { sanitizeError, summary, worthSince } from './summary.js';
import type { SecretKey } from './secrets.js';
import { getSettings, updateSettings } from './settings.js';
import type { Settings } from './settings.js';
import type { GmailSource } from './sources/gmail.js';
import { relayClient, relayConfig, RelayError, type RelayClient } from './sources/relayClient.js';
import { telegramBotInfo } from './sources/telegram.js';
import { createUpload, MAX_UPLOAD_BYTES, runUpload, UploadError } from './sources/upload.js';

export { sanitizeError };

export interface ApiContext {
  /** Real deps + Gmail source; throws when Gmail or the chosen cloud storage is not connected yet. */
  getDeps: () => { deps: Deps; gmail: GmailSource };
  /** The worker's tick (it has its own mutex). Absent: POST /api/worker/run answers 503. */
  runTick?: () => Promise<void>;
  /** Injectable for tests; default reads settings and secrets. */
  getAi?: () => AiProvider | null;
  /** Injectable for tests; default makes the (read-only) Morning detection calls. */
  detectMorning?: () => Promise<{ api_fields: boolean; api_file: boolean }>;
  /** Injectable for tests; default reads the categories from Morning (read-only GET). */
  morningClassifications?: () => Promise<MorningClassification[]>;
  /** Injectable for tests; default asks Telegram who the bot is (read-only getMe). */
  telegramInfo?: () => Promise<{ username: string }>;
  /** Injectable for tests; default searches Morning's expenses and drafts (read-only). Null: no API keys. */
  morningLookup?: () => Lookup | null;
  /** Injectable for tests; default talks to the shared-bot hub over HTTP. */
  relayClient?: (url: string, auth: string | null) => RelayClient;
  now?: () => Date;
}

/**
 * The background backfill run of each tenant (single process; key '' outside any tenant). "Running" is this
 * in-memory promise, never a persisted flag, so a restart mid-run cannot leave the UI stuck on "running".
 */
const backfillJobs = new Map<string, Promise<void>>();
const jobKey = () => currentTenantId() ?? '';
/** Resolves when every current background backfill has finished. For tests and shutdown. */
export const backfillJobDone = async (): Promise<void> => { await Promise.all([...backfillJobs.values()]); };

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const notFound = (what: string) => new HttpError(404, `${what}_not_found`);

const ITEM_STATES = [
  'queued', 'waiting_ai', 'needs_attention', 'awaiting_vendor', 'awaiting_backfill_approval',
  'ready', 'stored', 'done', 'ignored', 'dismissed',
] as const satisfies readonly ItemState[];

const FieldsPatch = z.object({
  vendorName: z.string().nullable(),
  vendorTaxId: z.string().nullable(),
  docType: z.enum(['tax_invoice', 'receipt', 'tax_invoice_receipt', 'credit_note', 'other']).nullable(),
  docNumber: z.string().nullable(),
  issueDate: z.string().nullable(),
  total: z.number().finite().nullable(),
  vat: z.number().finite().nullable(),
  net: z.number().finite().nullable(),
  currency: z.string().nullable(),
  allocationNumber: z.string().nullable(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  vatConfirmed: z.boolean(),
}).partial().strict();

const ListQuery = z.object({
  state: z.enum(ITEM_STATES).optional(),
  q: z.string().max(200).optional(),
  worth: z.enum(['1']).optional(),
  vendor: z.string().min(1).max(100).optional(),
  /** Exact category; "-" = documents without one. */
  category: z.string().min(1).max(200).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  /** Filed only (stored or done), as the summary counts them. Ignored when `state` is given. */
  filed: z.enum(['1']).optional(),
  sort: z.enum(ITEM_SORTS).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const StatsQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });

const Ids = z.object({ ids: z.array(z.string().min(1)).max(1000) }).strict();
/** Catch-up check and send run in small batches so each request stays short; the page sends batch after batch. */
const CatchupBatch = z.object({ ids: z.array(z.string().min(1)).min(1).max(25) }).strict();
const CatchupMark = z.object({
  ids: z.array(z.string().min(1)).min(1).max(1000),
  as: z.enum(['in_morning', 'skipped']),
  refs: z.record(z.string(), z.object({ where: z.enum(['expense', 'draft']), morningId: z.string().min(1).max(100) })).optional(),
}).strict();

/** One lookup per tenant, so its short draft cache serves a whole run of batches. */
const lookups = new Map<string, MorningLookup>();
function defaultLookup(): Lookup | null {
  if (!getSecret('morning_id') || !getSecret('morning_secret')) return null;
  const key = currentTenantId() ?? '';
  let l = lookups.get(key);
  if (!l) { l = new MorningLookup(); lookups.set(key, l); }
  return l;
}

const SettingsPatch = z.object({
  currency: z.string().min(1),
  currencyLabel: z.string().min(1),
  vatRate: z.number().min(0).max(100),
  gmailLabel: z.string().min(1).nullable(),
  storageProvider: z.enum(['dropbox', 'gdrive']),
  storageRoot: z.string(),
  folderTemplate: z.string().min(1),
  filenameTemplate: z.string().min(1),
  categories: z.array(z.object({
    name: z.string().min(1), sendToAccounting: z.boolean(), accountingClassification: z.string().optional(),
  }).strict()),
  ai: z.object({
    mode: z.enum(['anthropic', 'openai', 'gemini', 'ssh', 'none']),
    model: z.string().trim().optional(),
    ssh: z.object({
      host: z.string().min(1), port: z.number().int().min(1).max(65535),
      user: z.string().min(1), hostKeySha256: z.string().min(1),
    }).strict().optional(),
  }).strict(),
  morning: z.object({
    mode: z.enum(['api_fields', 'api_file', 'email']).nullable(), inboxEmail: z.string().optional(),
  }).strict(),
  setupComplete: z.boolean(),
  pollMinutes: z.number().int().min(1).max(1440),
  timezone: z.string().refine((tz) => {
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
  }, 'unknown timezone'),
  telegramChatIds: z.array(z.string().regex(/^-?\d{1,20}$/)).max(10),
  telegramRelayUrl: z.string().trim().max(300).regex(/^(https?:\/\/[^\s]+)?$/),
  shareRecipes: z.boolean(),
  ownTaxIds: z.array(z.string().trim().regex(/^\d{8,9}$/)).max(5),
  autoApproveVendors: z.boolean(),
}).partial().strict();

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown): RequestHandler =>
  (req, res, next) => { Promise.resolve().then(() => fn(req, res)).catch(next); };

const parse = <T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> => schema.parse(data);
const param = (req: Request, name: string) => String(req.params[name]);

function eventsOf(itemId: string) {
  const rows = getDb().prepare(
    'SELECT at, from_state, to_state, note FROM item_events WHERE item_id = ? ORDER BY id').all(itemId) as
    { at: string; from_state: string | null; to_state: string; note: string | null }[];
  return rows.map((e) => ({ at: e.at, from: e.from_state, to: e.to_state, note: sanitizeError(e.note) }));
}

/** The email a document came from (null for an uploaded one), with a link that opens it in Gmail. */
function emailOf(messageId: string) {
  if (isUploadId(messageId)) return null;
  const e = getEmail(messageId);
  if (!e) return null;
  return {
    sender: e.sender, subject: e.subject, receivedAt: e.receivedAt,
    gmailUrl: /^[0-9a-f]{6,32}$/i.test(messageId) ? `https://mail.google.com/mail/u/0/#all/${messageId}` : null,
  };
}

/** 'Name <A@B.co>' → 'a@b.co'. */
function bareAddress(s: string): string {
  const m = /<([^<>]+)>/.exec(s);
  return (m?.[1] ?? s).trim().toLowerCase();
}

function publicSettings(s: Settings) {
  return { ...s, lastTickError: sanitizeError(s.lastTickError), backfillError: sanitizeError(s.backfillError) };
}

export function apiRouter(ctx: ApiContext): express.Router {
  const r = express.Router();
  const clock = ctx.now ?? (() => new Date());
  /** Detected Morning modes, per tenant (in memory, like before: a restart forgets them). */
  const morningModesByTenant = new Map<string, { api_fields: boolean; api_file: boolean }>();
  const morningModes = () => morningModesByTenant.get(jobKey()) ?? null;

  /** Deps for routes that act on Gmail/cloud storage; 503 while those are not connected. */
  const live = () => {
    try { return ctx.getDeps(); } catch { throw new HttpError(503, 'not_connected'); }
  };

  r.use(requireUser);

  r.get('/summary', wrap((_req, res) => { res.json(summary(clock())); }));

  r.get('/stats', wrap((req, res) => {
    const q = parse(StatsQuery, req.query);
    res.json(stats(q.year ?? clock().getFullYear()));
  }));

  r.post('/worker/run', wrap(async (_req, res) => {
    if (!ctx.runTick) throw new HttpError(503, 'worker_unavailable');
    await ctx.runTick();
    res.json(summary(clock()));
  }));

  r.get('/ingest-failures', wrap((_req, res) => {
    res.json(listIngestFailures().map((f) => ({ ...f, error: sanitizeError(f.error) })));
  }));

  // ---------- items ----------
  r.get('/items', wrap((req, res) => {
    const q = parse(ListQuery, req.query);
    const worthIds = q.worth
      ? new Set(getDb().prepare('SELECT id FROM items WHERE recipe_failed = 1 AND updated_at >= ?').pluck()
        .all(worthSince(clock())) as string[])
      : null;
    const filter = {
      state: q.state ?? (q.filed ? ['stored', 'done'] as ItemState[] : undefined), q: q.q || undefined, vendorKey: q.vendor,
      category: q.category === '-' ? null : q.category, year: q.year, sort: q.sort, dir: q.dir,
    };
    const items = (worthIds
      ? listItems({ ...filter, limit: 100_000 }).filter((i) => worthIds.has(i.id)).slice(q.offset, q.offset + q.limit)
      : listItems({ ...filter, limit: q.limit, offset: q.offset }))
      .map(({ text, ...rest }) => ({ ...rest, hasText: !!text?.trim(), email: emailOf(rest.messageId) }));
    res.json({ items, limit: q.limit, offset: q.offset });
  }));

  r.get('/items/:id', wrap((req, res) => {
    const item = getItem(param(req, 'id'));
    if (!item) throw notFound('item');
    const { text, ...rest } = item;
    res.json({
      ...rest, hasText: !!text?.trim(), events: eventsOf(item.id), emailMode: getEmail(item.messageId)?.mode ?? null,
      aiUsage: itemUsage(item.id), email: emailOf(item.messageId),
    });
  }));

  r.get('/items/:id/pdf', wrap((req, res) => {
    const pdf = getItem(param(req, 'id')) ? getItemPdf(param(req, 'id')) : null;
    if (!pdf) throw notFound('pdf');
    // The bytes came from an email: never sniffed as HTML, no script/same-origin powers, generic name.
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; frame-ancestors 'self'",
      'Content-Disposition': 'inline; filename="document.pdf"',
    });
    res.type('application/pdf').send(pdf);
  }));

  // A photographed paper receipt (JPEG) or a PDF, as the raw request body. Read and filed like an emailed one.
  r.post('/uploads', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'unsupported_file');
    const { name } = parse(z.object({ name: z.string().max(300).optional() }), req.query);
    let created: { id: string; duplicateOf?: string };
    try { created = createUpload('upload', name, req.body, clock()); } catch (e) {
      if (e instanceof UploadError) throw new HttpError(e.code === 'too_large' ? 413 : 400, e.code);
      throw e;
    }
    const lean = ({ text: _text, ...rest }: Item) => rest;
    if (created.duplicateOf) {
      res.json({ id: created.duplicateOf, duplicate: true, item: lean(getItem(created.duplicateOf)!) });
      return;
    }
    let deps: Deps | null = null;
    try { deps = ctx.getDeps().deps; } catch { /* not connected yet: stays queued for the worker */ }
    res.status(201).json({ id: created.id, duplicate: false, item: lean(await runUpload(created.id, deps)) });
  }));

  const EDITABLE: ItemState[] = ['needs_attention', 'awaiting_vendor', 'awaiting_backfill_approval', 'ready'];
  r.put('/items/:id/fields', wrap((req, res) => {
    const patch = parse(FieldsPatch, req.body);
    const item = getItem(param(req, 'id'));
    if (!item) throw notFound('item');
    if (!EDITABLE.includes(item.state)) throw new HttpError(409, 'item_not_editable');
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'empty_patch');
    if (patch.category && !getSettings().categories.some((c) => c.name === patch.category)) {
      throw new HttpError(400, 'unknown_category');
    }
    const empty: ExtractedFields = {
      vendorName: null, vendorTaxId: null, docType: null, docNumber: null, issueDate: null, total: null,
      vat: null, net: null, currency: null, allocationNumber: null, description: null, category: null,
    };
    const fields: ExtractedFields = { ...empty, ...(item.fields ?? {}), ...patch };
    setItemFields(item.id, fields, 'manual');
    // An item that never had a vendor (AI could not name one) gets it from the edit, and then needs the
    // vendor decision like any new vendor: it must never be filed without one.
    let vendorAssigned = false;
    if (!item.vendorKey) {
      const key = vendorKeyFor(fields);
      if (key) {
        if (!getVendor(key)) upsertVendor(key, (fields.vendorName ?? '').trim().slice(0, 100) || key);
        setItemVendor(item.id, key);
        vendorAssigned = true;
      }
    }
    const today = clock().toISOString().slice(0, 10);
    const check = validateFields(fields, getSettings(), today);
    let after = getItem(item.id)!;
    const vendor = after.vendorKey ? getVendor(after.vendorKey) : null;
    // §4.5: a backfill item is filed only after approval, so a fixed one goes back to the approval list.
    const fixedTo: ItemState = vendor?.status === 'unreviewed' ? 'awaiting_vendor'
      : vendor?.status === 'ignored' ? 'ignored'
        : getEmail(item.messageId)?.mode === 'backfill' ? 'awaiting_backfill_approval' : 'ready';
    const reroute = after.state === 'needs_attention'
      || (vendorAssigned && (after.state === 'ready' || after.state === 'awaiting_backfill_approval'));
    if (check.ok && reroute && fixedTo !== after.state) {
      transition(item.id, fixedTo, fixedTo === 'awaiting_vendor' ? 'new_vendor' : undefined,
        fixedTo === 'ignored' ? 'vendor_ignored' : 'manual_edit');
      after = getItem(item.id)!;
    } else if (!check.ok && (after.state === 'ready' || after.state === 'awaiting_backfill_approval')) {
      transition(item.id, 'needs_attention', check.problems[0], `manual_edit_invalid:${check.problems.join(',')}`);
      after = getItem(item.id)!;
    }
    res.json({ item: after, valid: check.ok, problems: check.ok ? [] : check.problems });
  }));

  r.post('/items/:id/retry', wrap((req, res) => {
    const item = getItem(param(req, 'id'));
    if (!item) throw notFound('item');
    if (item.state !== 'needs_attention') throw new HttpError(409, 'item_not_retryable');
    const to: ItemState = item.reason === 'storage_error' ? 'ready'
      : item.reason === 'accounting_error' ? 'stored' : 'queued';
    getDb().transaction(() => { // fresh retry budget, as the pipeline does on every state change
      updateItem(item.id, { attempts: 0, nextAttemptAt: null });
      transition(item.id, to, undefined, 'manual_retry');
    })(); // the worker picks it up on its next tick
    res.json(getItem(item.id));
  }));

  // The owner asks to read one unfiled document again with its vendor's current recipe (no AI).
  r.post('/items/:id/reparse', wrap((req, res) => {
    const item = getItem(param(req, 'id'));
    if (!item) throw notFound('item');
    if (!EDITABLE.includes(item.state) || item.storagePath) throw new HttpError(409, 'item_not_editable');
    if (!item.text?.trim()) throw new HttpError(409, 'item_no_text');
    const r = reparseItem(item.id, getSettings(), clock());
    res.json({ outcome: r.outcome, problems: r.problems, item: getItem(item.id) });
  }));

  // A receipt set aside because its tax invoice is on file (pipeline settleReceiptPair): the owner files it anyway.
  r.post('/items/:id/keep-receipt', wrap((req, res) => {
    const item = getItem(param(req, 'id'));
    if (!item) throw notFound('item');
    const paired = item.state === 'ignored' && eventsOf(item.id).some((e) => e.note?.startsWith('receipt_of_invoice:'));
    if (!paired) throw new HttpError(409, 'item_not_set_aside_receipt');
    const vendor = item.vendorKey ? getVendor(item.vendorKey) : null;
    const to: ItemState = !vendor || vendor.status === 'unreviewed' ? 'awaiting_vendor'
      : vendor.status === 'ignored' ? 'ignored'
        : item.storagePath ? 'stored'
          : getEmail(item.messageId)?.mode === 'backfill' ? 'awaiting_backfill_approval' : 'ready';
    getDb().transaction(() => {
      updateItem(item.id, { attempts: 0, nextAttemptAt: null });
      transition(item.id, to, to === 'awaiting_vendor' ? 'new_vendor' : undefined, 'receipt_kept');
    })();
    res.json(getItem(item.id));
  }));

  // The owner changes their mind about a document: dismissed even after it was filed or sent. The file stays in
  // storage and any Morning draft stays there; the document just leaves the summary and stops moving.
  r.post('/items/:id/dismiss', wrap((req, res) => {
    const item = getItem(param(req, 'id'));
    if (!item) throw notFound('item');
    if (item.state === 'dismissed' || item.state === 'ignored') throw new HttpError(409, 'item_already_final');
    transition(item.id, 'dismissed', undefined, 'manual_dismiss');
    res.json(getItem(item.id));
  }));

  // A document that should not have been collected: its file is deleted from the cloud (recoverable there), its
  // Morning draft is taken back when Morning allows it, and the document is dismissed. `ignoreVendor` also stops
  // collecting this supplier's documents. Whatever could not be taken back is reported, never hidden.
  r.post('/items/:id/remove', wrap(async (req, res) => {
    const body = parse(z.object({ ignoreVendor: z.boolean().optional() }).strict(), req.body ?? {});
    const item = getItem(param(req, 'id'));
    if (!item) throw notFound('item');
    let deps: Deps | null = null;
    try { deps = ctx.getDeps().deps; } catch { /* not connected: nothing in the cloud can be removed now */ }
    let storage: 'removed' | 'not_found' | 'none' | 'failed' = 'none';
    let storageError: string | undefined;
    if (item.storagePath) {
      if (!deps?.storage.remove) { storage = 'failed'; storageError = 'storage_not_connected'; } else {
        try { storage = await deps.storage.remove(item.storagePath); } catch (e) {
          storage = 'failed'; storageError = sanitizeError((e as Error).message) ?? undefined;
        }
      }
    }
    let morning: 'removed' | 'manual' | 'none' = 'none';
    let morningReason: string | undefined;
    if (item.accountingRef) {
      if (!deps?.accounting?.remove) { morning = 'manual'; morningReason = 'accounting_not_connected'; } else {
        const r = await deps.accounting.remove({ ref: item.accountingRef, mode: item.accountingMode, fields: item.fields });
        morning = r.outcome; morningReason = r.reason ? sanitizeError(r.reason) ?? undefined : undefined;
      }
    }
    getDb().transaction(() => {
      // What is gone from a destination is forgotten, so a later restore files / sends it again.
      updateItem(item.id, {
        attempts: 0, nextAttemptAt: null,
        ...(storage === 'removed' || storage === 'not_found' ? { storagePath: null } : {}),
        ...(morning === 'removed' ? { accountingRef: null, accountingMode: null } : {}),
      });
      const note = `manual_remove: storage=${storage}${storageError ? ` (${storageError})` : ''}; morning=${morning}${morningReason ? ` (${morningReason})` : ''}`;
      if (item.state === 'dismissed') {
        getDb().prepare('INSERT INTO item_events (item_id, at, from_state, to_state, note) VALUES (?, ?, ?, ?, ?)')
          .run(item.id, clock().toISOString(), 'dismissed', 'dismissed', note);
      } else transition(item.id, 'dismissed', undefined, note);
      if (body.ignoreVendor && item.vendorKey && getVendor(item.vendorKey)) setVendorStatus(item.vendorKey, 'ignored');
    })();
    res.json({ item: getItem(item.id), storage, storageError, morning, morningReason });
  }));

  // The way back: a dismissed or ignored document re-enters the flow where it belongs. A filed one returns to
  // filed (accounting decides again), an unread one is read again, an approved-vendor one is filed.
  r.post('/items/:id/restore', wrap((req, res) => {
    const item = getItem(param(req, 'id'));
    if (!item) throw notFound('item');
    if (item.state !== 'dismissed' && item.state !== 'ignored') throw new HttpError(409, 'item_not_restorable');
    const vendor = item.vendorKey ? getVendor(item.vendorKey) : null;
    if (vendor?.status === 'ignored') throw new HttpError(409, 'item_vendor_ignored');
    const check = item.fields ? validateFields(item.fields, getSettings(), clock().toISOString().slice(0, 10)) : null;
    const pendingBackfill = getEmail(item.messageId)?.mode === 'backfill' && !getSettings().backfillDone;
    const to: ItemState = !item.fields ? 'queued'
      : !vendor || vendor.status === 'unreviewed' ? 'awaiting_vendor'
        : item.storagePath ? (item.accountingRef ? 'done' : 'stored')
          : !check!.ok ? 'needs_attention'
            : pendingBackfill ? 'awaiting_backfill_approval' : 'ready';
    const reason = to === 'awaiting_vendor' ? 'new_vendor' as const : to === 'needs_attention' && check && !check.ok ? check.problems[0] : undefined;
    try {
      getDb().transaction(() => {
        updateItem(item.id, { attempts: 0, nextAttemptAt: null });
        transition(item.id, to, reason, 'manual_restore');
      })();
    } catch (e) {
      // Dismissed copies sit outside the doc-number index: a second live copy of the same document is refused.
      if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HttpError(409, 'item_duplicate');
      throw e;
    }
    res.json(getItem(item.id));
  }));

  // ---------- notifications ----------
  r.get('/notifications', wrap((_req, res) => {
    res.json({ notifications: listNotifications(50), unread: unreadNotifications() });
  }));
  r.post('/notifications/read', wrap((req, res) => {
    const { ids } = parse(z.object({ ids: z.array(z.number().int()).max(500).optional() }).strict(), req.body ?? {});
    res.json({ changed: markNotificationsRead(ids), unread: unreadNotifications() });
  }));

  // Web Push: the device (browser or home-screen app) subscribes with this instance's public key.
  r.get('/push/key', wrap((_req, res) => { res.json({ publicKey: vapidPublicKey() }); }));
  const PushSub = z.object({
    endpoint: z.string().url().max(1000),
    keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }).passthrough(),
  }).passthrough();
  r.post('/push/subscribe', wrap((req, res) => {
    const sub = parse(PushSub, req.body);
    if (!isAllowedEndpoint(sub.endpoint)) throw new HttpError(400, 'push_endpoint_not_allowed');
    savePushSubscription({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
      req.get('user-agent') ?? null, clock());
    res.json({ ok: true });
  }));
  r.post('/push/unsubscribe', wrap((req, res) => {
    const { endpoint } = parse(z.object({ endpoint: z.string().max(1000) }).strict(), req.body);
    deletePushSubscription(endpoint);
    res.json({ ok: true });
  }));
  r.post('/push/test', wrap(async (_req, res) => {
    res.json(await sendPush({ title: 'אוסף החשבוניות', body: 'התראות פועלות במכשיר הזה ✓', url: '/attention', tag: 'test' }));
  }));

  // ---------- vendors ----------
  r.get('/vendors', wrap((_req, res) => { res.json(listVendors()); }));

  const VendorPatch = z.object({
    status: z.enum(['business', 'personal', 'ignored', 'unreviewed']).optional(),
    defaultCategory: z.string().nullable().optional(),
  }).strict();
  r.put('/vendors/:key', wrap(async (req, res) => {
    const key = param(req, 'key');
    const body = parse(VendorPatch, req.body);
    const vendor = getVendor(key);
    if (!vendor) throw notFound('vendor');
    if (body.defaultCategory) {
      if (!getSettings().categories.some((c) => c.name === body.defaultCategory)) {
        throw new HttpError(400, 'unknown_category');
      }
    }
    if (body.defaultCategory !== undefined) setVendorCategory(key, body.defaultCategory);
    let touched: string[] = [];
    let processed = true;
    if (body.status && body.status !== vendor.status) {
      let live_: { deps: Deps; gmail: GmailSource } | null = null;
      try { live_ = ctx.getDeps(); } catch { /* not connected yet */ }
      if (live_) touched = await setVendorDecision(key, body.status, live_.deps);
      else { // keep the decision; the worker moves the vendor's awaiting items on once connected
        setVendorStatus(key, body.status);
        processed = false;
      }
    }
    res.json({ vendor: getVendor(key), touched, processed });
  }));

  r.get('/vendors/:key/recipes', wrap((req, res) => {
    const key = param(req, 'key');
    if (!getVendor(key)) throw notFound('vendor');
    res.json(recipeHistory(key));
  }));

  r.put('/vendors/:key/recipe', wrap((req, res) => {
    const key = param(req, 'key');
    const recipe = compileRecipe(req.body); // throws RecipeError -> 400 with its message
    if (recipe.vendorKey !== key) throw new HttpError(400, 'recipe_vendor_mismatch');
    const id = saveRecipe(recipe, 'user');
    // The vendor's documents imported before this fix are read again with it.
    res.json({ ok: true, id, reapplied: reapplyVendorRecipe(key, getSettings(), clock()) });
  }));

  // The owner tries a recipe (saved or not) on one of the vendor's documents: what it reads, field by field,
  // next to the document's values. No AI, nothing saved.
  const TryRecipe = z.object({ itemId: z.string().min(1), recipe: z.unknown() }).strict();
  r.post('/vendors/:key/recipe/test', wrap((req, res) => {
    const key = param(req, 'key');
    const { itemId, recipe: raw } = parse(TryRecipe, req.body);
    if (!getVendor(key)) throw notFound('vendor');
    const item = getItem(itemId);
    if (!item || item.vendorKey !== key) throw notFound('item');
    if (!item.text?.trim() || !item.fields) throw new HttpError(409, 'item_not_readable');
    const recipe = compileRecipe(raw); // throws RecipeError -> 400 with its message
    res.json({ check: checkRecipe(recipe, item.text, item.fields), text: item.text });
  }));

  // The AI rewrites the vendor's recipe from one of its documents, guided by the owner's notes. Nothing is
  // saved: the draft goes back to the editor, and the owner saves it (or not) like a hand-edited recipe.
  const Regenerate = z.object({ itemId: z.string().min(1), comment: z.string().trim().max(2000).default('') }).strict();
  r.post('/vendors/:key/recipe/regenerate', wrap(async (req, res) => {
    const key = param(req, 'key');
    const { itemId, comment } = parse(Regenerate, req.body);
    const vendor = getVendor(key);
    if (!vendor) throw notFound('vendor');
    const item = getItem(itemId);
    if (!item || item.vendorKey !== key) throw notFound('item');
    if (!item.text?.trim() || !item.fields) throw new HttpError(409, 'item_not_readable');
    const ai = ctx.getAi ? ctx.getAi() : getAiProvider(getSettings());
    if (!ai) throw new HttpError(400, 'ai_not_configured');
    const previous = getActiveRecipe(key) ?? undefined;
    const sender = isUploadId(item.messageId) ? '' : bareAddress(getEmail(item.messageId)?.sender ?? '');
    let draft;
    const usage = emptyTotals();
    try {
      draft = await aiWriteRecipe(
        ai, { text: item.text, sender, fields: item.fields, previous, feedback: comment || undefined },
        { purpose: 'regenerate', itemId: item.id, sink: usage },
      );
    } catch (e) {
      if (e instanceof AiUnavailableError) throw new HttpError(503, 'ai_unavailable');
      if (e instanceof AiOutputError) throw new HttpError(502, 'ai_bad_recipe');
      throw e;
    }
    // Ours, not the AI's: the key and name, and the vendor's AI-always choice (a miss is reported, not applied).
    const { aiAlways: _drop, ...rest } = draft;
    const recipe = compileRecipe({
      ...rest, vendorKey: key, displayName: previous?.displayName ?? vendor.displayName,
      ...(previous?.aiAlways ? { aiAlways: true } : {}),
    });
    const check = checkRecipe(recipe, item.text, item.fields);
    res.json({ recipe, reproduces: check.ok, check, text: item.text, usage });
  }));

  r.put('/vendors/:key/ai-always', wrap((req, res) => {
    const key = param(req, 'key');
    const { value } = parse(z.object({ value: z.boolean() }).strict(), req.body);
    if (!getVendor(key)) throw notFound('vendor');
    const recipe = getActiveRecipe(key);
    if (!recipe) throw notFound('recipe');
    const { aiAlways: _drop, ...rest } = recipe;
    saveRecipe(value ? { ...rest, aiAlways: true } : rest, 'user');
    const reapplied = value ? { checked: 0, updated: 0 } : reapplyVendorRecipe(key, getSettings(), clock());
    res.json({ ok: true, aiAlways: value, reapplied });
  }));

  r.get('/ai/usage', wrap((_req, res) => { res.json(usageSummary(clock())); }));

  // ---------- backfill ----------
  r.get('/backfill', wrap(async (_req, res) => {
    const rows = await backfillList(live().deps);
    const s = getSettings();
    res.json({
      rows, running: backfillJobs.has(jobKey()), startedAt: s.backfillStartedAt, finishedAt: s.backfillFinishedAt,
      result: s.backfillResult, error: sanitizeError(s.backfillError), aiUsage: usageSummary(clock()).backfill,
      receiptsSetAside: getDb().prepare(
        `SELECT COUNT(*) FROM items i JOIN emails e ON e.message_id = i.message_id
         WHERE e.mode = 'backfill' AND i.state = 'ignored' AND EXISTS (
           SELECT 1 FROM item_events v WHERE v.item_id = i.id AND v.note LIKE 'receipt_of_invoice:%')`).pluck().get() as number,
    });
  }));
  /** Starts the background run; the caller checked nothing else is running. */
  const launchBackfill = (key: string, { deps, gmail }: ReturnType<typeof live>) => {
    updateSettings({ backfillFinishedAt: null, backfillResult: null, backfillError: null });
    const done = (patch: Partial<Settings>) => updateSettings({ backfillFinishedAt: clock().toISOString(), ...patch });
    const job = startBackfill(gmail, deps)
      .then((result) => { done({ backfillResult: result }); })
      .catch((e: unknown) => { done({ backfillError: sanitizeError(e instanceof Error ? e.message : String(e)) }); })
      .finally(() => { backfillJobs.delete(key); })
      // Terminal: a throw while recording the outcome must never become an unhandled rejection.
      .catch((e: unknown) => { console.error('backfill outcome not recorded:', e instanceof Error ? e.message : 'error'); });
    backfillJobs.set(key, job);
  };
  // Long (every email since 1 January): answers 202 at once and runs in the background; GET /backfill polls it.
  r.post('/backfill/start', wrap((_req, res) => {
    const key = jobKey();
    if (backfillJobs.has(key)) throw new HttpError(409, 'backfill_running');
    if (getSettings().backfillDone) throw new HttpError(409, 'backfill_done');
    launchBackfill(key, live());
    res.status(202).json({ started: true });
  }));
  // Starts the first import over, whatever happened before: forgets every document and email (as reset-data),
  // then runs the import again with today's rules. The body must say so explicitly, against stray calls.
  r.post('/backfill/rerun', wrap(async (req, res) => {
    parse(z.object({ confirm: z.literal('rerun') }).strict(), req.body);
    const key = jobKey();
    if (backfillJobs.has(key)) throw new HttpError(409, 'backfill_running');
    const ctx = live();
    backfillJobs.set(key, Promise.resolve()); // holds the slot while the reset runs: a second click gets 409
    let cleared;
    try {
      cleared = await resetData(ctx.gmail);
    } catch (e) {
      backfillJobs.delete(key);
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'gmail_unavailable');
    }
    launchBackfill(key, ctx);
    res.status(202).json({ started: true, cleared });
  }));
  r.post('/backfill/approve', wrap(async (req, res) => {
    const { ids } = parse(Ids, req.body);
    await approveBackfill(ids, live().deps);
    res.json({ ok: true });
  }));
  r.post('/backfill/skip', wrap((req, res) => {
    const { ids } = parse(Ids, req.body);
    res.json({ skipped: skipBackfill(ids) });
  }));
  r.post('/backfill/finish', wrap((_req, res) => {
    if (backfillJobs.has(jobKey())) throw new HttpError(409, 'backfill_running'); // items are still arriving
    // A run cut short by a restart left emails unread: restart it before ending the first run.
    if (getSettings().backfillError === BACKFILL_INTERRUPTED) throw new HttpError(409, 'backfill_interrupted');
    res.json({ dismissed: finishBackfill() });
  }));

  // Wipes every document and email (a test run's leftovers) so the first import can run again. Gmail's done label
  // comes off first; if Gmail fails, nothing is deleted. The body must say so explicitly, against stray calls.
  r.post('/reset-data', wrap(async (req, res) => {
    parse(z.object({ confirm: z.literal('reset') }).strict(), req.body);
    if (backfillJobs.has(jobKey())) throw new HttpError(409, 'backfill_running');
    const gmail = markedEmailIds().length > 0 ? live().gmail : null;
    try {
      res.json(await resetData(gmail));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'gmail_unavailable');
    }
  }));

  // ---------- missed ----------
  r.get('/missed', wrap((_req, res) => { res.json(listMissed()); }));
  r.post('/missed/:id/queue', wrap(async (req, res) => {
    const id = param(req, 'id');
    if (!listMissed().some((m) => m.messageId === id)) throw notFound('missed');
    const { deps, gmail } = live();
    await queueMissed(gmail, id, deps);
    res.json({ ok: true });
  }));
  r.post('/missed/:id/hide', wrap((req, res) => {
    const id = param(req, 'id');
    if (!listMissed().some((m) => m.messageId === id)) throw notFound('missed');
    hideMissed(id);
    res.json({ ok: true });
  }));

  // ---------- gmail ----------
  // What the app read so far, turned into one Gmail filter and the owner's likely business tax id.
  r.get('/gmail/suggestions', wrap((_req, res) => {
    res.json({ filter: suggestFilter(), ownTaxIds: suggestOwnTaxIds() });
  }));
  r.get('/gmail/labels', wrap(async (_req, res) => {
    const { gmail } = live();
    if (!gmail.listLabels) throw new HttpError(503, 'not_connected');
    let labels: string[];
    try { labels = await gmail.listLabels(); } catch {
      throw new HttpError(502, 'gmail_unavailable'); // the UI falls back to typing the label name
    }
    res.json({ labels });
  }));

  // ---------- cloud storage (Dropbox or Google Drive, whichever is chosen) ----------
  // Folder browser for the storage root: read-only, one level at a time.
  r.get('/storage/folders', wrap(async (req, res) => {
    const { path } = parse(z.object({ path: z.string().max(1000).default('') }), req.query);
    const { storage } = live().deps;
    if (!storage.listFolders) throw new HttpError(503, 'not_connected');
    try {
      res.json({ path, folders: await storage.listFolders(path) });
    } catch (e) {
      if (e instanceof FolderNotFoundError) throw new HttpError(404, 'folder_not_found');
      throw new HttpError(502, 'storage_unavailable');
    }
  }));

  // A new folder from the folder browser: one name inside the folder being browsed.
  const NewFolder = z.object({
    parent: z.string().max(1000).default(''),
    name: z.string().trim().min(1).max(255).refine((n) => !/[\\/:*?"<>|]/.test(n) && n !== '.' && n !== '..' && !/[. ]$/.test(n)),
  }).strict();
  r.post('/storage/folders', wrap(async (req, res) => {
    const { parent, name } = parse(NewFolder, req.body);
    const { storage } = live().deps;
    if (!storage.createFolder) throw new HttpError(503, 'not_connected');
    try {
      res.status(201).json({ folder: await storage.createFolder(parent, name) });
    } catch (e) {
      if (e instanceof FolderNotFoundError) throw new HttpError(404, 'folder_not_found');
      if (e instanceof FolderConflictError) throw new HttpError(409, 'folder_conflict');
      throw new HttpError(502, 'storage_unavailable');
    }
  }));

  // ---------- settings & secrets ----------
  r.get('/settings', wrap((_req, res) => {
    res.json({ settings: publicSettings(getSettings()), secrets: secretStatus(), morningModes: morningModes() });
  }));

  r.put('/settings', wrap((req, res) => {
    const { storageProvider, ...patch } = parse(SettingsPatch, req.body);
    // The SSH agent runs on the server's host and reads a shared folder: the owner's only.
    if (patch.ai?.mode === 'ssh' && !currentUser(res)?.isAdmin) throw new HttpError(403, 'ssh_owner_only');
    // One cloud at a time: switching disconnects the other (its token is deleted).
    if (storageProvider !== undefined) chooseStorage(storageProvider);
    // The stored credential belongs to the hub it was issued by: never carry it over to another address.
    if (patch.telegramRelayUrl !== undefined && patch.telegramRelayUrl !== getSettings().telegramRelayUrl) {
      setSecret('telegram_relay_auth', null);
    }
    const sharing = patch.shareRecipes !== undefined && patch.shareRecipes !== getSettings().shareRecipes ? patch.shareRecipes : null;
    const updated = updateSettings(patch as Partial<Settings>);
    // Turning sharing off withdraws what this user shared; turning it on offers their recipes again.
    if (sharing === false) withdrawShared();
    if (sharing === true) publishOwnRecipes();
    res.json({ settings: publicSettings(updated), secrets: secretStatus(), morningModes: morningModes() });
  }));

  r.put('/secrets/:key', wrap((req, res) => {
    const key = param(req, 'key');
    if (!(SECRET_KEYS as string[]).includes(key) || key === 'push_vapid') throw notFound('secret'); // push key: made by the server
    if (key === 'ssh_private_key' && !currentUser(res)?.isAdmin) throw new HttpError(403, 'ssh_owner_only');
    const { value } = parse(z.object({ value: z.string().min(1).max(20_000) }).strict(), req.body);
    setSecret(key as SecretKey, value);
    res.json({ key, configured: true }); // never echo the value
  }));

  r.post('/ai/test', wrap(async (_req, res) => {
    const ai = ctx.getAi ? ctx.getAi() : getAiProvider(getSettings());
    if (!ai) throw new HttpError(400, 'ai_not_configured');
    try {
      await ai.ping();
      res.json({ ok: true, provider: ai.name });
    } catch (e) {
      res.json({ ok: false, provider: ai.name, error: sanitizeError(e instanceof Error ? e.message : String(e)) });
    }
  }));

  r.post('/morning/detect', wrap(async (_req, res) => {
    const key = jobKey();
    const modes = await (ctx.detectMorning ?? detectMorningModes)();
    morningModesByTenant.set(key, modes);
    // Detected from the public docs and a read-only probe; not a verified document upload (R6).
    res.json({ modes, verified: false });
  }));

  r.post('/telegram/test', wrap(async (_req, res) => {
    try {
      res.json({ ok: true, ...(await (ctx.telegramInfo ?? telegramBotInfo)()) });
    } catch (e) {
      res.json({ ok: false, error: sanitizeError(e instanceof Error ? e.message : String(e)) });
    }
  }));

  // ---------- shared Telegram bot (hub) ----------
  const relay = (needAuth: boolean) => {
    const { url, auth } = relayConfig();
    if (!url) throw new HttpError(400, 'relay_not_configured');
    if (needAuth && !auth) throw new HttpError(409, 'relay_not_connected');
    return (ctx.relayClient ?? relayClient)(url, auth);
  };
  /** Hub failures reach the UI as a clean 502 with the hub's code. */
  const viaRelay = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) {
      // 404 from the address itself: nothing there speaks the hub's protocol.
      if (e instanceof RelayError) throw new HttpError(502, e.code === 'not_found' ? 'relay_not_found' : e.code);
      throw e;
    }
  };

  r.get('/telegram/relay', wrap(async (_req, res) => {
    const { url, auth } = relayConfig();
    if (!url || !auth) { res.json({ configured: !!url, connected: false, botUsername: null, chats: [] }); return; }
    try {
      res.json({ configured: true, connected: true, ...(await relay(true).status()) });
    } catch (e) {
      if (!(e instanceof RelayError)) throw e;
      res.json({ configured: true, connected: true, botUsername: null, chats: [], error: e.code });
    }
  }));

  // A pairing link for the owner to open in Telegram. Registers this instance with the hub on first use.
  r.post('/telegram/relay/connect', wrap(async (req, res) => {
    const { invite } = parse(z.object({ invite: z.string().trim().max(200).optional() }).strict(), req.body);
    const pair = async () => {
      if (!relayConfig().auth) setSecret('telegram_relay_auth', await relay(false).register(invite || undefined));
      return relay(true).pair();
    };
    res.json(await viaRelay(async () => {
      try { return await pair(); } catch (e) {
        // The hub no longer knows this instance (its data was reset): register again, once.
        if (!(e instanceof RelayError) || e.status !== 401) throw e;
        setSecret('telegram_relay_auth', null);
        return pair();
      }
    }));
  }));

  r.delete('/telegram/relay/chats/:id', wrap(async (req, res) => {
    await viaRelay(() => relay(true).unlink(param(req, 'id')));
    res.json({ ok: true });
  }));

  // ---------- catch-up send to Morning (first-import documents, or filed before Morning was connected) ----------
  const lookupNow = () => (ctx.morningLookup ?? defaultLookup)();
  r.get('/morning/catchup', wrap((_req, res) => {
    const s = getSettings();
    res.json({ rows: listCatchup(s), mode: s.morning.mode, canCheck: lookupNow() !== null });
  }));
  r.post('/morning/catchup/check', wrap(async (req, res) => {
    const { ids } = parse(CatchupBatch, req.body);
    const lookup = lookupNow();
    if (!lookup) throw new HttpError(409, 'morning_no_api_keys');
    const results = await checkCatchup(ids, getSettings(), lookup);
    res.json({ results: results.map((r) => ({ ...r, error: r.error ? sanitizeError(r.error) : undefined })) });
  }));
  r.post('/morning/catchup/send', wrap(async (req, res) => {
    const { ids } = parse(CatchupBatch, req.body);
    const { deps } = live();
    if (!deps.accounting || !getSettings().morning.mode) throw new HttpError(409, 'morning_not_configured');
    const results = await sendCatchup(ids, deps, lookupNow());
    res.json({ results: results.map((r) => ({ ...r, error: r.error ? sanitizeError(r.error) : undefined })) });
  }));
  r.post('/morning/catchup/mark', wrap((req, res) => {
    const { ids, as, refs } = parse(CatchupMark, req.body);
    res.json({ changed: markCatchup(ids, as, getSettings(), refs) });
  }));

  r.get('/morning/classifications', wrap(async (_req, res) => {
    try {
      res.json({ classifications: await (ctx.morningClassifications ?? fetchMorningClassifications)() });
    } catch (e) {
      // Not configured / rejected credentials / Morning down: a clean 502, never a stack or a secret.
      res.status(502).json({ error: 'morning_unavailable', message: sanitizeError(e instanceof Error ? e.message : String(e)) });
    }
  }));

  r.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });

  // Errors: zod -> 400 with field messages, RecipeError -> 400, HttpError as given; never a stack trace.
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: 'invalid_request',
        fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    } else if (err instanceof RecipeError) {
      res.status(400).json({ error: 'invalid_recipe', message: err.message });
    } else if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code });
    } else if ((err as { type?: string } | null)?.type === 'entity.too.large') {
      res.status(413).json({ error: 'too_large' });
    } else {
      console.error('api error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  return r;
}
