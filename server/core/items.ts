import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { sha256 } from './dedupe.js';
import { TERMINAL_STATES } from './types.js';
import type { ExtractedFields, ItemState, Provenance, Reason } from './types.js';

export interface EmailRow {
  messageId: string; threadId: string | null; sender: string | null; subject: string | null;
  receivedAt: string | null; mode: 'ongoing' | 'backfill' | 'manual'; gmailMarked: boolean;
}

export interface Item {
  id: string; messageId: string; attachmentName: string | null; hasPdf: boolean; sha256: string | null;
  text: string | null; state: ItemState; reason: Reason | null; fields: ExtractedFields | null;
  provenance: Provenance | null; vendorKey: string | null; recipeFailed: boolean;
  storagePath: string | null; accountingRef: string | null; accountingMode: string | null;
  attempts: number; nextAttemptAt: string | null; createdAt: string; updatedAt: string;
}

export interface ItemPatch {
  storagePath?: string | null; accountingRef?: string | null; accountingMode?: string | null;
  attempts?: number; nextAttemptAt?: string | null; recipeFailed?: boolean;
}

export interface ItemFilter {
  state?: ItemState | ItemState[]; messageId?: string; limit?: number; offset?: number; q?: string;
}

const now = () => new Date().toISOString();

/** Source rows of documents the owner uploaded (app or chat bot) carry this id prefix instead of a Gmail id. */
export const UPLOAD_PREFIX = 'upload:';
export const isUploadId = (messageId: string): boolean => messageId.startsWith(UPLOAD_PREFIX);

export function isTerminal(state: ItemState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function createEmail(row: {
  messageId: string; threadId: string; sender: string; subject: string; receivedAt: string;
  mode: 'ongoing' | 'backfill' | 'manual';
}): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO emails (message_id, thread_id, sender, subject, received_at, mode)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(row.messageId, row.threadId, row.sender, row.subject, row.receivedAt, row.mode);
}

export function getEmail(messageId: string): EmailRow | undefined {
  const r = getDb().prepare('SELECT * FROM emails WHERE message_id = ?').get(messageId) as
    Record<string, unknown> | undefined;
  if (!r) return undefined;
  return {
    messageId: r.message_id as string, threadId: r.thread_id as string | null,
    sender: r.sender as string | null, subject: r.subject as string | null,
    receivedAt: r.received_at as string | null, mode: r.mode as EmailRow['mode'],
    gmailMarked: r.gmail_marked === 1,
  };
}

function addEvent(itemId: string, from: string | null, to: string, note?: string): void {
  getDb()
    .prepare('INSERT INTO item_events (item_id, at, from_state, to_state, note) VALUES (?, ?, ?, ?, ?)')
    .run(itemId, now(), from, to, note ?? null);
}

function insertItem(
  id: string, messageId: string, attachmentName: string | null, pdf: Buffer | null,
  hash: string | null, state: ItemState, reason: Reason,
): void {
  const t = now();
  getDb()
    .prepare(`INSERT INTO items (id, message_id, attachment_name, pdf, sha256, state, reason, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, messageId, attachmentName, pdf, hash, state, state === 'queued' ? null : reason, t, t);
}

export function createItem(
  messageId: string, attachmentName: string | null, pdf: Buffer,
): { id: string; duplicateOf?: string } {
  const db = getDb();
  const id = randomUUID();
  const hash = sha256(pdf);
  return db.transaction(() => {
    const orig = db.prepare('SELECT id FROM items WHERE sha256 = ?').pluck().get(hash) as string | undefined;
    if (orig) {
      insertItem(id, messageId, attachmentName, pdf, null, 'dismissed', 'duplicate');
      addEvent(id, null, 'dismissed', `duplicate_of:${orig}`);
      return { id, duplicateOf: orig };
    }
    insertItem(id, messageId, attachmentName, pdf, hash, 'queued', 'duplicate');
    addEvent(id, null, 'queued');
    return { id };
  })();
}

export function createPlaceholderItem(messageId: string, reason: Reason, attachmentName: string | null = null): string {
  const id = randomUUID();
  getDb().transaction(() => {
    insertItem(id, messageId, attachmentName, null, null, 'needs_attention', reason);
    addEvent(id, null, 'needs_attention', reason);
  })();
  return id;
}

/** Records a note on the item's history without changing its state. */
export function noteItem(id: string, note: string): void {
  const db = getDb();
  const state = db.prepare('SELECT state FROM items WHERE id = ?').pluck().get(id) as ItemState | undefined;
  if (!state) throw new Error(`Unknown item: ${id}`);
  addEvent(id, state, state, note);
}

export function transition(id: string, to: ItemState, reason?: Reason, note?: string): void {
  const db = getDb();
  db.transaction(() => {
    const from = db.prepare('SELECT state FROM items WHERE id = ?').pluck().get(id) as ItemState | undefined;
    if (!from) throw new Error(`Unknown item: ${id}`);
    db.prepare('UPDATE items SET state = ?, reason = ?, updated_at = ? WHERE id = ?')
      .run(to, reason ?? null, now(), id);
    addEvent(id, from, to, note);
  })();
}

/** Transition only if the item is still in `from` (UPDATE ... WHERE state = ?). False when it moved meanwhile. */
export function transitionIf(id: string, from: ItemState, to: ItemState, reason?: Reason, note?: string): boolean {
  const db = getDb();
  return db.transaction(() => {
    const r = db.prepare('UPDATE items SET state = ?, reason = ?, updated_at = ? WHERE id = ? AND state = ?')
      .run(to, reason ?? null, now(), id, from);
    if (r.changes === 0) return false;
    addEvent(id, from, to, note);
    return true;
  })();
}

function rowToItem(r: Record<string, unknown>): Item {
  return {
    id: r.id as string, messageId: r.message_id as string, attachmentName: r.attachment_name as string | null,
    hasPdf: r.pdf !== null && r.pdf !== undefined, sha256: r.sha256 as string | null,
    text: r.text as string | null, state: r.state as ItemState, reason: r.reason as Reason | null,
    fields: r.fields_json ? (JSON.parse(r.fields_json as string) as ExtractedFields) : null,
    provenance: r.provenance as Provenance | null, vendorKey: r.vendor_key as string | null,
    recipeFailed: r.recipe_failed === 1, storagePath: r.storage_path as string | null,
    accountingRef: r.accounting_ref as string | null, accountingMode: r.accounting_mode as string | null,
    attempts: r.attempts as number, nextAttemptAt: r.next_attempt_at as string | null,
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}

// Everything except the PDF blob, which is large; use getItemPdf for it.
const COLS = `id, message_id, attachment_name, (pdf IS NOT NULL) AS pdf, sha256, text, state, reason, fields_json,
  provenance, vendor_key, recipe_failed, storage_path, accounting_ref, accounting_mode, attempts,
  next_attempt_at, created_at, updated_at`;

export function getItem(id: string): Item | undefined {
  const r = getDb().prepare(`SELECT ${COLS} FROM items WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? rowToItem({ ...r, pdf: r.pdf === 1 ? 1 : null }) : undefined;
}

export function getItemPdf(id: string): Buffer | null {
  return (getDb().prepare('SELECT pdf FROM items WHERE id = ?').pluck().get(id) as Buffer | null | undefined) ?? null;
}

export function listItems(filter: ItemFilter = {}): Item[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.state !== undefined) {
    const states = Array.isArray(filter.state) ? filter.state : [filter.state];
    if (states.length === 0) return [];
    where.push(`state IN (${states.map(() => '?').join(',')})`);
    args.push(...states);
  }
  if (filter.messageId) { where.push('message_id = ?'); args.push(filter.messageId); }
  if (filter.q) {
    const like = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(attachment_name LIKE ? ESCAPE '\\' OR vendor_key LIKE ? ESCAPE '\\' OR fields_json LIKE ? ESCAPE '\\')`);
    args.push(like, like, like);
  }
  const sql = `SELECT ${COLS} FROM items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`;
  args.push(filter.limit ?? 100, filter.offset ?? 0);
  return (getDb().prepare(sql).all(...args) as Record<string, unknown>[])
    .map((r) => rowToItem({ ...r, pdf: r.pdf === 1 ? 1 : null }));
}

/** Applies an update that may collide with the doc-number index; on collision the item is dismissed as a duplicate. */
function updateOrDismissDuplicate(id: string, sql: string, args: unknown[]): void {
  const db = getDb();
  db.transaction(() => {
    try {
      db.prepare(sql).run(...args, now(), id);
      return;
    } catch (e) {
      if ((e as { code?: string }).code !== 'SQLITE_CONSTRAINT_UNIQUE') throw e;
    }
    // Dismissed rows are outside the unique index, so dismiss first and then apply the update.
    const from = db.prepare('SELECT state FROM items WHERE id = ?').pluck().get(id) as ItemState;
    db.prepare("UPDATE items SET state = 'dismissed', reason = 'duplicate', updated_at = ? WHERE id = ?")
      .run(now(), id);
    db.prepare(sql).run(...args, now(), id);
    const after = db.prepare('SELECT vendor_key, fields_json FROM items WHERE id = ?').get(id) as
      { vendor_key: string | null; fields_json: string | null };
    const f = after.fields_json ? (JSON.parse(after.fields_json) as ExtractedFields) : null;
    const orig = db.prepare(
      `SELECT id FROM items WHERE id != ? AND vendor_key = ? AND state != 'dismissed'
         AND json_extract(fields_json, '$.docNumber') = ? AND json_extract(fields_json, '$.docType') IS ?`)
      .pluck().get(id, after.vendor_key, f?.docNumber ?? null, f?.docType ?? null) as string | undefined;
    addEvent(id, from, 'dismissed', `duplicate_of:${orig ?? 'unknown'}`);
  })();
}

export function setItemFields(id: string, fields: ExtractedFields, provenance: Provenance): void {
  updateOrDismissDuplicate(id, 'UPDATE items SET fields_json = ?, provenance = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(fields), provenance]);
}

export function setItemVendor(id: string, vendorKey: string): void {
  updateOrDismissDuplicate(id, 'UPDATE items SET vendor_key = ?, updated_at = ? WHERE id = ?', [vendorKey]);
}

export function setItemText(id: string, text: string): void {
  getDb().prepare('UPDATE items SET text = ?, updated_at = ? WHERE id = ?').run(text, now(), id);
}

const PATCH_COLS: Record<keyof ItemPatch, string> = {
  storagePath: 'storage_path', accountingRef: 'accounting_ref', accountingMode: 'accounting_mode',
  attempts: 'attempts', nextAttemptAt: 'next_attempt_at', recipeFailed: 'recipe_failed',
};

export function updateItem(id: string, patch: ItemPatch): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch) as [keyof ItemPatch, unknown][]) {
    if (v === undefined) continue;
    sets.push(`${PATCH_COLS[k]} = ?`);
    args.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
  }
  if (sets.length === 0) return;
  getDb().prepare(`UPDATE items SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, now(), id);
}
