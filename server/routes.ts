import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, ZodError } from 'zod';
import { AiOutputError, AiUnavailableError, aiWriteRecipe, getAiProvider, reproduces } from './ai/provider.js';
import type { AiProvider } from './ai/provider.js';
import { requireUser } from './auth.js';
import {
  approveBackfill, BACKFILL_INTERRUPTED, backfillList, finishBackfill, skipBackfill, startBackfill,
} from './core/backfill.js';
import { listIngestFailures } from './core/ingestFailures.js';
import {
  getEmail, getItem, getItemPdf, isUploadId, listItems, setItemFields, setItemVendor, transition, isTerminal, updateItem,
} from './core/items.js';
import { listMissed, hideMissed, queueMissed } from './core/missed.js';
import { setVendorDecision, vendorKeyFor } from './core/pipeline.js';
import { compileRecipe, RecipeError } from './core/recipe.js';
import {
  getActiveRecipe, getVendor, listVendors, recipeHistory, saveRecipe, setVendorCategory, setVendorStatus, upsertVendor,
} from './core/recipeStore.js';
import type { Item } from './core/items.js';
import { FolderConflictError, FolderNotFoundError } from './core/types.js';
import type { Deps, ExtractedFields, ItemState } from './core/types.js';
import { validateFields } from './core/validate.js';
import { getDb } from './db.js';
import { detectMorningModes, fetchMorningClassifications, type MorningClassification } from './destinations/morning.js';
import { secretStatus, SECRET_KEYS, setSecret } from './secrets.js';
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
  /** Real deps + Gmail source; throws when Gmail/Dropbox are not connected yet. */
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
  /** Injectable for tests; default talks to the shared-bot hub over HTTP. */
  relayClient?: (url: string, auth: string | null) => RelayClient;
  now?: () => Date;
}

/**
 * The one background backfill run (single process). "Running" is this in-memory promise, never a persisted flag,
 * so a restart mid-run cannot leave the UI stuck on "running".
 */
let backfillJob: Promise<void> | null = null;
/** Resolves when the current background backfill (if any) has finished. For tests and shutdown. */
export const backfillJobDone = (): Promise<void> => backfillJob ?? Promise.resolve();

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
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const StatsQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });

const Ids = z.object({ ids: z.array(z.string().min(1)).max(1000) }).strict();

const SettingsPatch = z.object({
  currency: z.string().min(1),
  currencyLabel: z.string().min(1),
  vatRate: z.number().min(0).max(100),
  gmailLabel: z.string().min(1).nullable(),
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
  let morningModes: { api_fields: boolean; api_file: boolean } | null = null;

  /** Deps for routes that act on Gmail/Dropbox; 503 while those are not connected. */
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
    const items = (worthIds
      ? listItems({ state: q.state, q: q.q || undefined, vendorKey: q.vendor, limit: 100_000 }).filter((i) => worthIds.has(i.id))
        .slice(q.offset, q.offset + q.limit)
      : listItems({ state: q.state, q: q.q || undefined, vendorKey: q.vendor, limit: q.limit, offset: q.offset }))
      .map(({ text, ...rest }) => ({ ...rest, hasText: !!text?.trim() }));
    res.json({ items, limit: q.limit, offset: q.offset });
  }));

  r.get('/items/:id', wrap((req, res) => {
    const item = getItem(param(req, 'id'));
    if (!item) throw notFound('item');
    const { text, ...rest } = item;
    res.json({ ...rest, hasText: !!text?.trim(), events: eventsOf(item.id), emailMode: getEmail(item.messageId)?.mode ?? null });
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

  r.post('/items/:id/dismiss', wrap((req, res) => {
    const item = getItem(param(req, 'id'));
    if (!item) throw notFound('item');
    if (isTerminal(item.state)) throw new HttpError(409, 'item_already_final');
    transition(item.id, 'dismissed', undefined, 'manual_dismiss');
    res.json(getItem(item.id));
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
    res.json({ ok: true, id: saveRecipe(recipe, 'user') });
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
    try {
      draft = await aiWriteRecipe(ai, { text: item.text, sender, fields: item.fields, previous, feedback: comment || undefined });
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
    res.json({ recipe, reproduces: reproduces(recipe, item.text, item.fields) });
  }));

  r.put('/vendors/:key/ai-always', wrap((req, res) => {
    const key = param(req, 'key');
    const { value } = parse(z.object({ value: z.boolean() }).strict(), req.body);
    if (!getVendor(key)) throw notFound('vendor');
    const recipe = getActiveRecipe(key);
    if (!recipe) throw notFound('recipe');
    const { aiAlways: _drop, ...rest } = recipe;
    saveRecipe(value ? { ...rest, aiAlways: true } : rest, 'user');
    res.json({ ok: true, aiAlways: value });
  }));

  // ---------- backfill ----------
  r.get('/backfill', wrap(async (_req, res) => {
    const rows = await backfillList(live().deps);
    const s = getSettings();
    res.json({
      rows, running: backfillJob !== null, startedAt: s.backfillStartedAt, finishedAt: s.backfillFinishedAt,
      result: s.backfillResult, error: sanitizeError(s.backfillError),
    });
  }));
  // Long (every email since 1 January): answers 202 at once and runs in the background; GET /backfill polls it.
  r.post('/backfill/start', wrap((_req, res) => {
    if (backfillJob) throw new HttpError(409, 'backfill_running');
    if (getSettings().backfillDone) throw new HttpError(409, 'backfill_done');
    const { deps, gmail } = live();
    updateSettings({ backfillFinishedAt: null, backfillResult: null, backfillError: null });
    const done = (patch: Partial<Settings>) => updateSettings({ backfillFinishedAt: clock().toISOString(), ...patch });
    backfillJob = startBackfill(gmail, deps)
      .then((result) => { done({ backfillResult: result }); })
      .catch((e: unknown) => { done({ backfillError: sanitizeError(e instanceof Error ? e.message : String(e)) }); })
      .finally(() => { backfillJob = null; })
      // Terminal: a throw while recording the outcome must never become an unhandled rejection.
      .catch((e: unknown) => { console.error('backfill outcome not recorded:', e instanceof Error ? e.message : 'error'); });
    res.status(202).json({ started: true });
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
    if (backfillJob) throw new HttpError(409, 'backfill_running'); // items are still arriving
    // A run cut short by a restart left emails unread: restart it before ending the first run.
    if (getSettings().backfillError === BACKFILL_INTERRUPTED) throw new HttpError(409, 'backfill_interrupted');
    res.json({ dismissed: finishBackfill() });
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
  r.get('/gmail/labels', wrap(async (_req, res) => {
    const { gmail } = live();
    if (!gmail.listLabels) throw new HttpError(503, 'not_connected');
    let labels: string[];
    try { labels = await gmail.listLabels(); } catch {
      throw new HttpError(502, 'gmail_unavailable'); // the UI falls back to typing the label name
    }
    res.json({ labels });
  }));

  // ---------- dropbox ----------
  // Folder browser for the storage root: read-only, one level at a time.
  r.get('/dropbox/folders', wrap(async (req, res) => {
    const { path } = parse(z.object({ path: z.string().max(1000).default('') }), req.query);
    const { storage } = live().deps;
    if (!storage.listFolders) throw new HttpError(503, 'not_connected');
    try {
      res.json({ path, folders: await storage.listFolders(path) });
    } catch (e) {
      if (e instanceof FolderNotFoundError) throw new HttpError(404, 'folder_not_found');
      throw new HttpError(502, 'dropbox_unavailable');
    }
  }));

  // A new folder from the folder browser: one name inside the folder being browsed.
  const NewFolder = z.object({
    parent: z.string().max(1000).default(''),
    name: z.string().trim().min(1).max(255).refine((n) => !/[\\/:*?"<>|]/.test(n) && n !== '.' && n !== '..' && !/[. ]$/.test(n)),
  }).strict();
  r.post('/dropbox/folders', wrap(async (req, res) => {
    const { parent, name } = parse(NewFolder, req.body);
    const { storage } = live().deps;
    if (!storage.createFolder) throw new HttpError(503, 'not_connected');
    try {
      res.status(201).json({ folder: await storage.createFolder(parent, name) });
    } catch (e) {
      if (e instanceof FolderNotFoundError) throw new HttpError(404, 'folder_not_found');
      if (e instanceof FolderConflictError) throw new HttpError(409, 'folder_conflict');
      throw new HttpError(502, 'dropbox_unavailable');
    }
  }));

  // ---------- settings & secrets ----------
  r.get('/settings', wrap((_req, res) => {
    res.json({ settings: publicSettings(getSettings()), secrets: secretStatus(), morningModes });
  }));

  r.put('/settings', wrap((req, res) => {
    const patch = parse(SettingsPatch, req.body);
    // The stored credential belongs to the hub it was issued by: never carry it over to another address.
    if (patch.telegramRelayUrl !== undefined && patch.telegramRelayUrl !== getSettings().telegramRelayUrl) {
      setSecret('telegram_relay_auth', null);
    }
    res.json({ settings: publicSettings(updateSettings(patch as Partial<Settings>)), secrets: secretStatus(), morningModes });
  }));

  r.put('/secrets/:key', wrap((req, res) => {
    const key = param(req, 'key');
    if (!(SECRET_KEYS as string[]).includes(key)) throw notFound('secret');
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
    morningModes = await (ctx.detectMorning ?? detectMorningModes)();
    // Detected from the public docs and a read-only probe; not a verified document upload (R6).
    res.json({ modes: morningModes, verified: false });
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
