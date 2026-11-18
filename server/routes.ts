import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, ZodError } from 'zod';
import { getAiProvider } from './ai/provider.js';
import type { AiProvider } from './ai/provider.js';
import { requireUser } from './auth.js';
import { approveBackfill, backfillList, finishBackfill, skipBackfill, startBackfill } from './core/backfill.js';
import { listIngestFailures } from './core/ingestFailures.js';
import {
  getEmail, getItem, getItemPdf, listItems, setItemFields, setItemVendor, transition, isTerminal, updateItem,
} from './core/items.js';
import { listMissed, hideMissed, queueMissed } from './core/missed.js';
import { setVendorDecision, vendorKeyFor } from './core/pipeline.js';
import { compileRecipe, RecipeError } from './core/recipe.js';
import {
  getActiveRecipe, getVendor, listVendors, recipeHistory, saveRecipe, setVendorCategory, setVendorStatus, upsertVendor,
} from './core/recipeStore.js';
import type { Deps, ExtractedFields, ItemState } from './core/types.js';
import { validateFields } from './core/validate.js';
import { getDb } from './db.js';
import { detectMorningModes } from './destinations/morning.js';
import { secretStatus, SECRET_KEYS, setSecret } from './secrets.js';
import { sanitizeError, summary, worthSince } from './summary.js';
import type { SecretKey } from './secrets.js';
import { getSettings, updateSettings } from './settings.js';
import type { Settings } from './settings.js';
import type { GmailSource } from './sources/gmail.js';

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
}).partial().strict();

const ListQuery = z.object({
  state: z.enum(ITEM_STATES).optional(),
  q: z.string().max(200).optional(),
  worth: z.enum(['1']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

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
      ? listItems({ state: q.state, q: q.q || undefined, limit: 100_000 }).filter((i) => worthIds.has(i.id))
        .slice(q.offset, q.offset + q.limit)
      : listItems({ state: q.state, q: q.q || undefined, limit: q.limit, offset: q.offset }))
      .map(({ text: _text, ...rest }) => rest);
    res.json({ items, limit: q.limit, offset: q.offset });
  }));

  r.get('/items/:id', wrap((req, res) => {
    const item = getItem(param(req, 'id'));
    if (!item) throw notFound('item');
    res.json({ ...item, events: eventsOf(item.id), emailMode: getEmail(item.messageId)?.mode ?? null });
  }));

  r.get('/items/:id/pdf', wrap((req, res) => {
    const pdf = getItem(param(req, 'id')) ? getItemPdf(param(req, 'id')) : null;
    if (!pdf) throw notFound('pdf');
    res.type('application/pdf').send(pdf);
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
    const { deps, gmail } = live();
    updateSettings({ backfillFinishedAt: null, backfillResult: null, backfillError: null });
    const done = (patch: Partial<Settings>) => updateSettings({ backfillFinishedAt: clock().toISOString(), ...patch });
    backfillJob = startBackfill(gmail, deps)
      .then((result) => { done({ backfillResult: result }); })
      .catch((e: unknown) => { done({ backfillError: sanitizeError(e instanceof Error ? e.message : String(e)) }); })
      .finally(() => { backfillJob = null; });
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

  // ---------- settings & secrets ----------
  r.get('/settings', wrap((_req, res) => {
    res.json({ settings: publicSettings(getSettings()), secrets: secretStatus(), morningModes });
  }));

  r.put('/settings', wrap((req, res) => {
    const patch = parse(SettingsPatch, req.body);
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
    } else {
      console.error('api error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'internal_error' });
    }
  });

  return r;
}
