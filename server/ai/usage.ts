import { getDb } from '../db.js';
import { getSettings } from '../settings.js';

/** Tokens one AI reply cost, as the provider reported them; null when the provider does not say (SSH agent). */
export interface AiUsage { inputTokens: number | null; outputTokens: number | null }

/** What an AI call was for. */
export type AiPurpose = 'extract' | 'recipe' | 'regenerate';

/** Calls and tokens summed over some AI calls. `unknownCalls`: calls whose provider reported no token counts. */
export interface UsageTotals { calls: number; inputTokens: number; outputTokens: number; unknownCalls: number }

/**
 * Who to charge an AI call to. `sink`, when given, also adds up the calls made under this tag, so a caller can
 * report what one action cost (e.g. one recipe regeneration).
 */
export interface UsageTag { purpose: AiPurpose; itemId?: string | null; sink?: UsageTotals }

export const emptyTotals = (): UsageTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, unknownCalls: 0 });

export function addUsage(t: UsageTotals, u: AiUsage | null): void {
  t.calls++;
  if (!u || (u.inputTokens === null && u.outputTokens === null)) { t.unknownCalls++; return; }
  t.inputTokens += u.inputTokens ?? 0;
  t.outputTokens += u.outputTokens ?? 0;
}

/** Non-negative integer or null. */
export const tokens = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;

/** Local calendar day (settings timezone) of `at`, so "today" and "this month" match what the owner sees. */
function localDay(at: Date): string {
  let tz: string | undefined;
  try { tz = getSettings().timezone; } catch { tz = undefined; }
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * Records one AI reply. Never throws: usage is bookkeeping, and a failure here must not fail the document
 * (nor a test that runs the AI without a database).
 */
export function recordAiUsage(tag: UsageTag, provider: string, model: string | null, u: AiUsage | null, at = new Date()): void {
  if (tag.sink) addUsage(tag.sink, u);
  try {
    getDb().prepare(
      `INSERT INTO ai_usage (at, day, purpose, item_id, provider, model, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(at.toISOString(), localDay(at), tag.purpose, tag.itemId ?? null, provider, model, u?.inputTokens ?? null, u?.outputTokens ?? null);
  } catch { /* no database (tests) or a write failure: the document goes on */ }
}

const SUM = `SELECT COUNT(*) AS calls, COALESCE(SUM(u.input_tokens), 0) AS inputTokens,
  COALESCE(SUM(u.output_tokens), 0) AS outputTokens,
  COALESCE(SUM(CASE WHEN u.input_tokens IS NULL AND u.output_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unknownCalls
  FROM ai_usage u`;

function sum(where: string, ...args: unknown[]): UsageTotals {
  return getDb().prepare(`${SUM} ${where}`).get(...args) as UsageTotals;
}

/** Tokens spent on one document (reading it and writing recipes from it). */
export function itemUsage(itemId: string): UsageTotals {
  return sum('WHERE u.item_id = ?', itemId);
}

/** Today, this month, everything, and the first import (every call made for a document from a backfill email). */
export function usageSummary(now = new Date()): {
  today: UsageTotals; month: UsageTotals; total: UsageTotals; backfill: UsageTotals;
} {
  const day = localDay(now);
  return {
    today: sum('WHERE u.day = ?', day),
    month: sum('WHERE substr(u.day, 1, 7) = ?', day.slice(0, 7)),
    total: sum(''),
    backfill: sum(`JOIN items i ON i.id = u.item_id JOIN emails e ON e.message_id = i.message_id WHERE e.mode = 'backfill'`),
  };
}
