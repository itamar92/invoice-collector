import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z, ZodError } from 'zod';
import { requireApiToken } from './auth.js';
import { listItems } from './core/items.js';
import { summary } from './summary.js';

const Query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

/** PUBLIC_URL without trailing slashes; empty when unset (links are then relative). */
const base = () => (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');

/**
 * Read-only API for the account-manager app, behind a bearer token (API_TOKEN). No CORS headers are set.
 * Exposes counts and display fields only: never PDF bytes, extracted text, tax ids, secrets or raw error text.
 */
export function apiV1Router(now: () => Date = () => new Date()): express.Router {
  const r = express.Router();
  r.use(requireApiToken);

  r.get('/summary', (_req, res) => {
    res.json({ ...summary(now()), reviewUrl: `${base()}/attention` });
  });

  // Newest first by when the item was ingested (created_at), the order listItems returns.
  // `date` is the invoice's issue date when extracted, else the ingestion date.
  r.get('/invoices', (req, res) => {
    const { limit } = Query.parse(req.query);
    const items = listItems({ state: ['queued', 'waiting_ai', 'needs_attention', 'awaiting_vendor',
      'awaiting_backfill_approval', 'ready', 'stored', 'done'], limit });
    res.json(items.map((i) => ({
      id: i.id,
      date: i.fields?.issueDate ?? i.createdAt.slice(0, 10),
      vendor: i.fields?.vendorName ?? null,
      total: i.fields?.total ?? null,
      currency: i.fields?.currency ?? null,
      category: i.fields?.category ?? null,
      state: i.state,
      reason: i.reason, // enum code only
      storagePath: i.storagePath,
      accountingMode: i.accountingMode,
      url: `${base()}/items/${i.id}`,
    })));
  });

  r.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) res.status(400).json({ error: 'invalid_request' });
    else {
      console.error('api v1 error:', err instanceof Error ? err.message : err);
      res.status(500).json({ error: 'internal_error' });
    }
  });
  return r;
}
