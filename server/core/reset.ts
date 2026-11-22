import { getDb } from '../db.js';
import { updateSettings } from '../settings.js';
import type { GmailSource } from '../sources/gmail.js';

export interface ResetResult { items: number; emails: number; unlabelled: number }

/** Emails this app labelled done in Gmail (they must lose the label, or a new first import would skip them). */
export function markedEmailIds(): string[] {
  return getDb().prepare('SELECT message_id FROM emails WHERE gmail_marked = 1').pluck().all() as string[];
}

/**
 * Forgets every document and email the app has seen, so the first import can run again from scratch (after a
 * test run whose files were deleted from storage). Kept: connections, settings, vendors, recipes and AI usage.
 * Files already in cloud storage and documents already sent to accounting are not touched.
 *
 * Gmail goes first: if taking the done label off fails, nothing is deleted and the reset can simply be retried.
 */
export async function resetData(gmail: GmailSource | null): Promise<ResetResult> {
  const marked = markedEmailIds();
  if (marked.length > 0) {
    if (!gmail?.unmarkHandled) throw new Error('gmail_not_connected');
    await gmail.unmarkHandled(marked);
  }
  const db = getDb();
  const counts = db.transaction(() => {
    const items = db.prepare('SELECT COUNT(*) FROM items').pluck().get() as number;
    const emails = db.prepare('SELECT COUNT(*) FROM emails').pluck().get() as number;
    db.exec(`
      DELETE FROM item_events;
      DELETE FROM items;
      DELETE FROM missed;
      DELETE FROM ingest_failures;
      DELETE FROM emails;
    `);
    return { items, emails };
  })();
  updateSettings({
    backfillDone: false, backfillStartedAt: null, backfillFinishedAt: null, backfillResult: null, backfillError: null,
  });
  return { ...counts, unlabelled: marked.length };
}
