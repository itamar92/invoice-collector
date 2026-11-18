import { listIngestFailures } from './core/ingestFailures.js';
import { listMissed } from './core/missed.js';
import type { ItemState } from './core/types.js';
import { getDb } from './db.js';
import { getSecret, SECRET_KEYS } from './secrets.js';
import { getSettings } from './settings.js';

/** Strips URLs and any stored secret value, and caps the length, before text from errors reaches a response. */
export function sanitizeError(s: string | null | undefined): string | null {
  if (s == null) return null;
  let out = s.replace(/(?:https?:\/\/|www\.)\S+/gi, '[url]');
  for (const k of SECRET_KEYS) {
    let v: string | null = null;
    try { v = getSecret(k); } catch { /* unreadable secret: nothing to redact */ }
    if (v && v.length >= 8) out = out.split(v).join('[redacted]');
  }
  return out.slice(0, 500);
}

const WORTH_DAYS = 14;
export const worthSince = (now: Date) => new Date(now.getTime() - WORTH_DAYS * 86_400_000).toISOString();

export function summary(now: Date) {
  const db = getDb();
  const count = (state: ItemState) =>
    db.prepare('SELECT COUNT(*) FROM items WHERE state = ?').pluck().get(state) as number;
  const needsAttention = count('needs_attention');
  const awaitingVendor = count('awaiting_vendor');
  const ingestFailures = listIngestFailures().length;
  const s = getSettings();
  return {
    attention: needsAttention + awaitingVendor + ingestFailures, // R21: open ingest failures need the user too
    awaitingVendor,
    waitingAi: count('waiting_ai'),
    worthALook: db.prepare('SELECT COUNT(*) FROM items WHERE recipe_failed = 1 AND updated_at >= ?').pluck()
      .get(worthSince(now)) as number,
    missedOpen: listMissed('open').length,
    ingestFailures,
    lastTickAt: s.lastTickAt,
    lastTickError: sanitizeError(s.lastTickError),
    lastAiSuccessAt: s.lastAiSuccessAt,
  };
}

