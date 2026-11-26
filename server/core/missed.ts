import { getDb } from '../db.js';
import { getSettings } from '../settings.js';
import { DONE_LABEL, ingestMessage, invoiceQuery } from '../sources/gmail.js';
import { knownVendorSenders } from './recipeStore.js';
import type { GmailSource } from '../sources/gmail.js';
import { recordIngestFailure } from './ingestFailures.js';
import { getEmail, listItems } from './items.js';
import { processItem } from './pipeline.js';
import type { Deps } from './types.js';

export type MissedStatus = 'open' | 'queued' | 'hidden';
export interface MissedRow {
  messageId: string; sender: string | null; subject: string | null; receivedAt: string | null;
  foundAt: string; status: MissedStatus;
}

const clean = (s: string) => s.replace(/["\\]/g, '');

/**
 * Missed-by-label scan (spec §4.5a): messages that look like invoices but have none of the user's labels. Needs one.
 * Nothing is processed; unseen ids are recorded as `open`. `after` is YYYY-MM-DD. Returns how many were added.
 */
export async function scanMissed(gmail: GmailSource, after: string): Promise<number> {
  const labels = getSettings().gmailLabels;
  if (labels.length === 0) return 0;
  const without = labels.map((l) => `-label:"${clean(l)}"`).join(' ');
  const q = `${invoiceQuery(knownVendorSenders())} ${without} -label:"${DONE_LABEL}" after:${after.replaceAll('-', '/')}`;
  const db = getDb();
  const known = db.prepare('SELECT 1 FROM missed WHERE message_id = ?').pluck();
  let added = 0;
  for (const id of await gmail.searchMessages(q)) {
    if (getEmail(id) || known.get(id)) continue;
    const h = await gmail.fetchHeaders(id);
    db.prepare(`INSERT OR IGNORE INTO missed (message_id, sender, subject, received_at, found_at, status)
                VALUES (?, ?, ?, ?, ?, 'open')`)
      .run(id, h.sender, h.subject, h.receivedAt, new Date().toISOString());
    added++;
  }
  return added;
}

export function listMissed(status?: MissedStatus): MissedRow[] {
  const rows = getDb().prepare(
    `SELECT * FROM missed ${status ? 'WHERE status = ?' : ''} ORDER BY received_at DESC, message_id`)
    .all(...(status ? [status] : [])) as Record<string, string | null>[];
  return rows.map((r) => ({
    messageId: r.message_id as string, sender: r.sender, subject: r.subject, receivedAt: r.received_at,
    foundAt: r.found_at as string, status: r.status as MissedStatus,
  }));
}

/** One-click "add to queue": ingests the message as a manual email and runs its new items. */
export async function queueMissed(gmail: GmailSource, id: string, deps: Deps): Promise<void> {
  const row = getDb().prepare('SELECT status FROM missed WHERE message_id = ?').pluck().get(id) as MissedStatus | undefined;
  if (!row) throw new Error(`Unknown missed message: ${id}`);
  if (row === 'queued') return;
  try {
    await ingestMessage(gmail, id, 'manual');
  } catch (e) {
    recordIngestFailure(id, 'manual', e); // stays open; retryIngestFailures marks it queued on success
    return;
  }
  getDb().prepare(`UPDATE missed SET status = 'queued' WHERE message_id = ?`).run(id);
  for (const it of listItems({ messageId: id, limit: 1000 })) {
    if (it.state !== 'queued') continue;
    try { await processItem(it.id, deps); } catch { /* recorded on the item */ }
  }
}

export function hideMissed(id: string): void {
  getDb().prepare(`UPDATE missed SET status = 'hidden' WHERE message_id = ?`).run(id);
}
