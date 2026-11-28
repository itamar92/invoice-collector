import { getDb } from '../db.js';
import { sendPush } from '../push.js';
import { getSettings, updateSettings } from '../settings.js';
import { getEmail, getItem } from './items.js';

/**
 * In-app notifications. `processed`: an ongoing document finished its run (filed, and sent to accounting when it
 * belongs there). The bell builds its text from `data`; devices that turned on push get a Hebrew message as well.
 */
export type NotificationKind = 'processed';

export interface NotificationData {
  vendor: string | null; docType: string | null; docNumber: string | null;
  total: number | null; currency: string | null;
  /** Sent to accounting in this run (false: filed only, e.g. a personal supplier or a category not sent). */
  sent: boolean;
  storagePath: string | null;
}

export interface Notification {
  id: number; at: string; kind: NotificationKind; itemId: string | null; data: NotificationData; read: boolean;
}

const MAX_KEPT = 500;

/**
 * Records that `itemId` finished processing. Documents of the first import are not announced one by one (there
 * can be hundreds; the import page reports them), and a document is announced only once.
 */
export function notifyProcessed(itemId: string, sent: boolean, now = new Date()): void {
  const item = getItem(itemId);
  if (!item) return;
  if (getEmail(item.messageId)?.mode === 'backfill') return;
  const db = getDb();
  if (db.prepare(`SELECT 1 FROM notifications WHERE item_id = ? AND kind = 'processed'`).get(itemId)) return;
  const f = item.fields;
  const data: NotificationData = {
    vendor: f?.vendorName ?? item.attachmentName ?? null, docType: f?.docType ?? null, docNumber: f?.docNumber ?? null,
    total: f?.total ?? null, currency: f?.currency ?? null, sent, storagePath: item.storagePath,
  };
  db.prepare('INSERT INTO notifications (at, kind, item_id, data_json) VALUES (?, ?, ?, ?)')
    .run(now.toISOString(), 'processed', itemId, JSON.stringify(data));
  db.prepare(`DELETE FROM notifications WHERE id <= (SELECT MAX(id) FROM notifications) - ?`).run(MAX_KEPT);
  const at = now.toISOString();
  if (!db.prepare('SELECT 1 FROM push_subscriptions LIMIT 1').get()) {
    updateSettings({ lastPush: { at, devices: 0, sent: 0, error: null } });
    return;
  }
  void sendPush(pushText(itemId, data))
    .then((r) => { updateSettings({ lastPush: { at, devices: r.devices, sent: r.sent, error: r.errors.join(' · ').slice(0, 300) || null } }); })
    .catch(() => {});
}

/** The device notification (Hebrew; the push service shows it as is). */
function pushText(itemId: string, d: NotificationData) {
  const cloud = getSettings().storageProvider === 'gdrive' ? 'Google Drive' : 'Dropbox';
  const amount = d.total === null ? '' : ` · ${d.currency && d.currency !== 'ILS' ? `${d.total.toFixed(2)} ${d.currency}` : `₪${d.total.toFixed(2)}`}`;
  return {
    title: `חשבונית חדשה: ${d.vendor?.trim() || 'מסמך'}`,
    body: `${d.sent ? `תויקה ב-${cloud} ונשלחה ל-Morning` : `תויקה ב-${cloud}`}${amount}`,
    url: `/items/${itemId}`, tag: `item-${itemId.slice(0, 20)}`,
  };
}

export function listNotifications(limit = 50): Notification[] {
  const rows = getDb().prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: r.id as number, at: r.at as string, kind: r.kind as NotificationKind, itemId: r.item_id as string | null,
    data: JSON.parse(r.data_json as string) as NotificationData, read: r.read === 1,
  }));
}

export function unreadNotifications(): number {
  return getDb().prepare('SELECT COUNT(*) FROM notifications WHERE read = 0').pluck().get() as number;
}

/** Marks these (or, with no ids, all) notifications read. Returns how many changed. */
export function markNotificationsRead(ids?: number[]): number {
  const db = getDb();
  if (!ids) return db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run().changes;
  if (ids.length === 0) return 0;
  return db.prepare(`UPDATE notifications SET read = 1 WHERE read = 0 AND id IN (${ids.map(() => '?').join(',')})`)
    .run(...ids).changes;
}

/** Removes these (or, with no ids, all) notifications from the bell. Returns how many were removed. */
export function clearNotifications(ids?: number[]): number {
  const db = getDb();
  if (!ids) return db.prepare('DELETE FROM notifications').run().changes;
  if (ids.length === 0) return 0;
  return db.prepare(`DELETE FROM notifications WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids).changes;
}
