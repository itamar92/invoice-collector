import { getDb } from '../db.js';
import { getSettings, updateSettings } from '../settings.js';
import { ingestMessage } from '../sources/gmail.js';
import type { GmailSource } from '../sources/gmail.js';
import { clearIngestFailure, listIngestFailures, recordIngestFailure } from './ingestFailures.js';
import { getItem, getItemPdf, listItems, transition } from './items.js';
import { buildFilename, buildFolder } from './naming.js';
import { processItem } from './pipeline.js';
import type { Deps, ItemState } from './types.js';

export interface BackfillRow {
  id: string;
  filename: string | null;
  folder: string | null;
  vendor: string | null;
  total: number | null;
  currency: string | null;
  issueDate: string | null;
  likelyDuplicate: boolean;
  state: ItemState;
}

/**
 * First run (spec §4.5): ingests every candidate dated from 1 January of the current tax year in backfill mode
 * and runs each new item as far as it goes (it stops at awaiting_backfill_approval). Nothing is filed or sent.
 * A failed fetch is recorded in ingest_failures and never aborts the run.
 */
export async function startBackfill(gmail: GmailSource, deps: Deps): Promise<{ emails: number; items: number; failed: number }> {
  const year = deps.now().getUTCFullYear();
  updateSettings({ backfillStartedAt: deps.now().toISOString(), backfillDone: false });
  const ids = await gmail.listCandidateMessages({
    after: `${year}/01/01`, labelled: getSettings().gmailLabel != null,
  });
  let emails = 0;
  let items = 0;
  let failed = 0;
  for (const id of ids) {
    let res: { skipped: boolean; items: number };
    try {
      res = await ingestMessage(gmail, id, 'backfill');
    } catch (e) {
      recordIngestFailure(id, 'backfill', e); // the worker retries these (retryIngestFailures)
      failed++;
      continue;
    }
    if (res.skipped) continue;
    emails++;
    items += res.items;
    for (const it of listItems({ messageId: id, limit: 1000 })) {
      if (it.state !== 'queued') continue;
      try { await processItem(it.id, deps); } catch { /* processItem records its own failures */ }
    }
  }
  return { emails, items, failed };
}

/** Unfinished items from backfill emails, with the proposed filename/folder and a duplicate hint. */
export async function backfillList(deps: Deps): Promise<BackfillRow[]> {
  const ids = getDb().prepare(
    `SELECT i.id FROM items i JOIN emails e ON e.message_id = i.message_id
     WHERE e.mode = 'backfill' AND i.state NOT IN ('done', 'ignored', 'dismissed')
     ORDER BY i.created_at, i.rowid`).pluck().all() as string[];
  const rows: BackfillRow[] = [];
  for (const id of ids) {
    const item = getItem(id);
    if (!item) continue;
    const f = item.fields;
    let filename: string | null = null;
    let folder: string | null = null;
    let likelyDuplicate = false;
    if (f) {
      try {
        filename = buildFilename(f, deps.settings);
        folder = buildFolder(f, deps.settings);
      } catch { filename = null; folder = null; }
    }
    const pdf = filename && folder ? getItemPdf(id) : null;
    if (filename && folder && pdf) {
      try { likelyDuplicate = (await deps.storage.exists(folder, filename, pdf)).exists; } catch { likelyDuplicate = false; }
    }
    rows.push({
      id, filename, folder, vendor: f?.vendorName ?? null, total: f?.total ?? null,
      currency: f?.currency ?? null, issueDate: f?.issueDate ?? null, likelyDuplicate, state: item.state,
    });
  }
  return rows;
}

function awaiting(ids: string[]): string[] {
  return ids.filter((id) => getItem(id)?.state === 'awaiting_backfill_approval');
}

/** Moves approved items on to filing; others (wrong state, unknown) are ignored. The pipeline skips accounting. */
export async function approveBackfill(ids: string[], deps: Deps): Promise<void> {
  const chosen = awaiting(ids);
  for (const id of chosen) transition(id, 'ready', undefined, 'backfill_approved');
  for (const id of chosen) {
    try { await processItem(id, deps); } catch { /* recorded on the item */ }
  }
}

/** Dismisses the chosen awaiting items. Returns how many changed. */
export function skipBackfill(ids: string[]): number {
  const chosen = awaiting(ids);
  for (const id of chosen) transition(id, 'dismissed', undefined, 'backfill_skipped');
  return chosen.length;
}

/** Ends the backfill: unapproved items are dismissed; items needing attention stay on the attention list. */
export function finishBackfill(): number {
  const ids = getDb().prepare(
    `SELECT id FROM items WHERE state = 'awaiting_backfill_approval'`).pluck().all() as string[];
  for (const id of ids) transition(id, 'dismissed', undefined, 'backfill_skipped');
  updateSettings({ backfillDone: true });
  return ids.length;
}

/** Settings value of backfillError for a run cut short by a restart (labelled in the UI). */
export const BACKFILL_INTERRUPTED = 'interrupted';

/**
 * Boot-time check: a run that started but neither finished nor was ended by the user was cut short by a restart
 * (the job lives only in memory). Marks it so the UI offers a restart instead of showing it as finished.
 */
export function markInterruptedBackfill(): boolean {
  const s = getSettings();
  if (!s.backfillStartedAt || s.backfillFinishedAt || s.backfillDone) return false;
  updateSettings({ backfillError: BACKFILL_INTERRUPTED });
  return true;
}

/** Re-ingests every recorded failure with its stored mode and runs the new items. Called by the worker. */
export async function retryIngestFailures(gmail: GmailSource, deps: Deps): Promise<{ retried: number; succeeded: number }> {
  let retried = 0;
  let succeeded = 0;
  for (const f of listIngestFailures()) {
    retried++;
    try {
      await ingestMessage(gmail, f.messageId, f.mode);
    } catch (e) {
      recordIngestFailure(f.messageId, f.mode, e);
      continue;
    }
    clearIngestFailure(f.messageId);
    succeeded++;
    getDb().prepare(`UPDATE missed SET status = 'queued' WHERE message_id = ? AND status = 'open'`).run(f.messageId);
    for (const it of listItems({ messageId: f.messageId, limit: 1000 })) {
      if (it.state !== 'queued') continue;
      try { await processItem(it.id, deps); } catch { /* recorded on the item */ }
    }
  }
  return { retried, succeeded };
}
