import type { ExtractedFields, ItemState, Reason } from '../server/core/types.js';
import type { Category, Settings, StorageProvider } from '../server/settings.js';
import type { SecretKey } from '../server/secrets.js';
import type { Stats } from '../server/stats.js';
import { tDyn } from './i18n/he.js';

export type { Category, StorageProvider, ExtractedFields, ItemState, Reason, SecretKey, Settings, Stats };

export interface Summary {
  attention: number; awaitingVendor: number; awaitingBackfillApproval: number; waitingAi: number; worthALook: number; missedOpen: number;
  /** Not filed yet: needs a fix / first-import approval (any time) / still being read or filed. */
  needsAttention: number; backfillWaiting: number; inProgress: number;
  ingestFailures: number; lastTickAt: string | null; lastTickError: string | null; lastAiSuccessAt: string | null;
  notificationsUnread: number;
}

/** The email a document came from; null for an uploaded one. */
export interface ItemEmail { sender: string | null; subject: string | null; receivedAt: string | null; gmailUrl: string | null }

/** "A document finished processing" (the UI writes the text). */
export interface AppNotification {
  id: number; at: string; kind: 'processed'; itemId: string | null; read: boolean;
  data: {
    vendor: string | null; docType: string | null; docNumber: string | null; total: number | null;
    currency: string | null; sent: boolean; storagePath: string | null;
  };
}

/** POST /items/:id/remove: what happened in each destination. */
export interface RemoveResult {
  item: Item; storage: 'removed' | 'not_found' | 'none' | 'failed'; storageError?: string;
  morning: 'removed' | 'manual' | 'none'; morningReason?: string;
}

export interface Item {
  id: string; messageId: string; attachmentName: string | null; hasPdf: boolean; state: ItemState;
  reason: Reason | null; fields: ExtractedFields | null; provenance: 'recipe' | 'ai' | 'manual' | null;
  vendorKey: string | null; recipeFailed: boolean; storagePath: string | null; accountingRef: string | null;
  accountingMode: string | null; attempts: number; createdAt: string; updatedAt: string;
  /** Lists only: the document's text was extracted (a recipe can be written from it). */
  hasText?: boolean;
  email?: ItemEmail | null;
}
/** Calls and tokens over some AI calls; `unknownCalls` reported no token counts (SSH agent). */
export interface AiUsageTotals { calls: number; inputTokens: number; outputTokens: number; unknownCalls: number }
export interface AiUsageSummary { today: AiUsageTotals; month: AiUsageTotals; total: AiUsageTotals; backfill: AiUsageTotals }
export type ReparseOutcome = 'updated' | 'same' | 'invalid' | 'no_recipe' | 'ai_always' | 'no_match' | 'not_editable' | 'busy';
/** After a recipe change: the vendor's unfiled documents read again with it. */
export interface Reapplied { checked: number; updated: number }
/** A recipe run on one document, field by field, next to the document's correct values. */
export interface RecipeCheck {
  ok: boolean;
  fields: { field: 'issueDate' | 'total' | 'docNumber' | 'vat' | 'net'; expected: string | number | null; got: string | number | null; required: boolean; ok: boolean }[];
}
export interface ItemEvent { at: string; from: string | null; to: string; note: string | null }
/** emailMode 'backfill': the item can be filed but is never sent to Morning, so the UI offers no "send". */
export type ItemDetail = Item & {
  events: ItemEvent[]; emailMode: 'ongoing' | 'backfill' | 'manual' | null; hasText: boolean; aiUsage: AiUsageTotals;
  email: ItemEmail | null;
};

export type VendorStatus = 'business' | 'personal' | 'ignored' | 'unreviewed';
/** A filed document that never went to Morning (first import, or Morning not connected yet). */
export interface CatchupRow {
  id: string; vendor: string | null; docNumber: string | null; issueDate: string | null; total: number | null;
  currency: string | null; category: string | null; filename: string | null; why: 'backfill' | 'not_configured';
}
export interface MorningMatch {
  status: 'found' | 'maybe' | 'not_found' | 'unknown'; where?: 'expense' | 'draft'; morningId?: string;
  seen?: { number: string | null; amount: number | null; supplier: string | null; date: string | null };
}
export type CatchupCheck = MorningMatch & { id: string; error?: string };
export interface CatchupSent { id: string; outcome: 'sent' | 'in_morning' | 'failed'; error?: string; match?: MorningMatch }
export type ItemSort = 'vendor' | 'category' | 'state' | 'date' | 'total';
export interface Vendor { key: string; displayName: string; status: VendorStatus; defaultCategory: string | null; createdAt: string }
export interface RecipeVersion { version: number; source: 'starter' | 'ai' | 'user' | 'shared'; createdAt: string; recipe: Record<string, unknown> & { aiAlways?: boolean } }

export interface BackfillRow {
  id: string; filename: string | null; folder: string | null; vendor: string | null; total: number | null;
  currency: string | null; issueDate: string | null; likelyDuplicate: boolean; state: ItemState;
}
/** GET /api/backfill: the rows plus the background run's status (polled while `running`). */
export interface BackfillStatus {
  rows: BackfillRow[]; running: boolean; startedAt: string | null; finishedAt: string | null;
  result: { emails: number; items: number; failed: number } | null; error: string | null;
  aiUsage: AiUsageTotals; receiptsSetAside: number;
}
export interface MissedRow {
  messageId: string; sender: string | null; subject: string | null; receivedAt: string | null;
  foundAt: string; status: 'open' | 'queued' | 'hidden';
}
export interface IngestFailure { messageId: string; mode: string; error: string; attempts: number; firstAt: string; lastAt: string }

export type MorningModes = { api_fields: boolean; api_file: boolean };
/** A Morning expense category; `id` goes into Category.accountingClassification. */
export interface MorningClassification {
  id: string; title: string; key: string | null; code: string | null;
  irsCode: number | null; type: number | null; income: number | null; vat: number | null;
}
export interface RelayStatus {
  configured: boolean; connected: boolean; botUsername: string | null;
  chats: { id: string; name: string | null; linkedAt: string }[]; error?: string;
}
/** The logged-in user (GET /api/me). */
export interface Me {
  id: string; email: string; name: string | null; isAdmin: boolean; hasPassword: boolean; hasGoogle: boolean;
  hasApiToken: boolean; googleLogin: boolean;
}
export interface AdminUser { id: string; email: string; name: string | null; isAdmin: boolean; disabled: boolean; createdAt: string; hasPassword: boolean; hasGoogle: boolean }
export interface InviteRow { id: string; email: string | null; createdAt: string; expiresAt: number; usedAt: string | null; usedBy: string | null }
export interface GmailSuggestions {
  filter: {
    query: string; subjects: { term: string; emails: number }[]; senders: { sender: string; emails: number }[];
    invoices: number; noise: number;
  };
  ownTaxIds: { taxId: string; vendors: number }[];
}
export interface SettingsResponse { settings: Settings; secrets: Record<SecretKey, boolean>; morningModes: MorningModes | null }

/** A failed API call; `message` is already Hebrew. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly body: Record<string, unknown> = {}) {
    super(tDyn(`error.${code}`, 'error.generic'));
  }
}

// ---------- requests in flight (drives the top loading bar) ----------
let inFlight = 0;
const busyListeners = new Set<(n: number) => void>();
const setInFlight = (d: number) => { inFlight += d; for (const l of busyListeners) l(inFlight); };
/** Calls `fn` with the number of requests in flight whenever it changes; returns the unsubscribe. */
export function onRequestsInFlight(fn: (n: number) => void): () => void {
  busyListeners.add(fn); fn(inFlight);
  return () => { busyListeners.delete(fn); };
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void { onUnauthorized = fn; }

/** `quiet`: a background poll, which does not show the loading bar. */
async function request<T>(method: string, path: string, body?: unknown, quiet = false): Promise<T> {
  if (quiet) return send0<T>(method, path, body);
  setInFlight(1);
  try { return await send0<T>(method, path, body); } finally { setInFlight(-1); }
}

async function send0<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      // A Blob goes as the raw body under its own type (file upload); anything else as JSON.
      headers: body === undefined ? {} : { 'content-type': body instanceof Blob ? body.type || 'application/octet-stream' : 'application/json' },
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') onUnauthorized();
    throw new ApiError(res.status, typeof data.error === 'string' ? data.error : 'generic', data);
  }
  return data as T;
}

const get = <T>(p: string, quiet = false) => request<T>('GET', p, undefined, quiet);
const send = <T>(m: 'POST' | 'PUT', p: string, b: unknown = {}) => request<T>(m, p, b);
const del = <T>(p: string) => request<T>('DELETE', p);
const enc = encodeURIComponent;

export const api = {
  login: (email: string, password: string) => send<void>('POST', '/api/login', { email, password }),
  logout: () => send<void>('POST', '/api/logout'),
  me: () => get<Me>('/api/me'),
  authOptions: () => get<{ google: boolean }>('/api/auth/options'),
  invite: (token: string) => get<{ email: string | null; google: boolean }>(`/api/invites/${enc(token)}`),
  acceptInvite: (token: string, body: { email: string; name?: string; password: string }) =>
    send<Me>('POST', `/api/invites/${enc(token)}/accept`, body),
  updateAccount: (patch: { email?: string; name?: string | null }) => send<Me>('PUT', '/api/account', patch),
  changePassword: (current: string | undefined, next: string) => send<void>('POST', '/api/account/password', { current, next }),
  createApiToken: () => send<{ token: string }>('POST', '/api/account/api-token'),
  deleteApiToken: () => del<void>('/api/account/api-token'),
  adminUsers: () => get<{ users: AdminUser[]; invites: InviteRow[] }>('/api/admin/users'),
  createInvite: (email?: string) => send<{ url: string; expiresAt: number }>('POST', '/api/admin/invites', email ? { email } : {}),
  revokeInvite: (id: string) => del<void>(`/api/admin/invites/${enc(id)}`),
  setUserDisabled: (id: string, disabled: boolean) => send<void>('POST', `/api/admin/users/${enc(id)}/disabled`, { disabled }),
  /** `quiet`: the periodic refresh, without the loading bar. */
  summary: (quiet = false) => get<Summary>('/api/summary', quiet),
  stats: (year?: number) => get<Stats>(`/api/stats${year ? `?year=${year}` : ''}`),
  runWorker: () => send<Summary>('POST', '/api/worker/run'),

  items: (q: {
    state?: ItemState; q?: string; worth?: boolean; vendor?: string; limit?: number; offset?: number;
    category?: string; year?: number; filed?: boolean; hideClosed?: boolean; sort?: ItemSort; dir?: 'asc' | 'desc';
  } = {}) => {
    const p = new URLSearchParams();
    if (q.state) p.set('state', q.state);
    if (q.category) p.set('category', q.category);
    if (q.year) p.set('year', String(q.year));
    if (q.filed) p.set('filed', '1');
    if (q.hideClosed) p.set('hideClosed', '1');
    if (q.sort) p.set('sort', q.sort);
    if (q.dir) p.set('dir', q.dir);
    if (q.vendor) p.set('vendor', q.vendor);
    if (q.q) p.set('q', q.q);
    if (q.worth) p.set('worth', '1');
    p.set('limit', String(q.limit ?? 50));
    p.set('offset', String(q.offset ?? 0));
    return get<{ items: Item[]; limit: number; offset: number }>(`/api/items?${p}`);
  },
  item: (id: string) => get<ItemDetail>(`/api/items/${enc(id)}`),
  pdfUrl: (id: string) => `/api/items/${enc(id)}/pdf`,
  saveFields: (id: string, patch: Partial<ExtractedFields>) =>
    send<{ item: Item; valid: boolean; problems: Reason[] }>('PUT', `/api/items/${enc(id)}/fields`, patch),
  retry: (id: string) => send<Item & { refetched?: number }>('POST', `/api/items/${enc(id)}/retry`),
  dismiss: (id: string) => send<Item>('POST', `/api/items/${enc(id)}/dismiss`),
  /** Deletes the filed copy from the cloud, takes back the Morning draft when possible, and dismisses. */
  remove: (id: string, ignoreVendor = false) => send<RemoveResult>('POST', `/api/items/${enc(id)}/remove`, { ignoreVendor }),
  notifications: (quiet = false) => get<{ notifications: AppNotification[]; unread: number }>('/api/notifications', quiet),
  pushKey: () => get<{ publicKey: string }>('/api/push/key'),
  pushSubscribe: (sub: PushSubscriptionJSON) => send<{ ok: true }>('POST', '/api/push/subscribe', sub),
  pushUnsubscribe: (endpoint: string) => send<{ ok: true }>('POST', '/api/push/unsubscribe', { endpoint }),
  pushTest: () => send<{ sent: number; failed: number; devices: number; errors: string[] }>('POST', '/api/push/test'),
  clearNotifications: (ids?: number[]) => send<{ changed: number; unread: number }>('POST', '/api/notifications/clear', ids ? { ids } : {}),
  /** "Worth a look" documents the owner checked: off that list (until the vendor's recipe fails on them again). */
  worthReviewed: (ids?: string[]) => send<{ changed: number }>('POST', '/api/items/worth-reviewed', ids ? { ids } : {}),
  readNotifications: (ids?: number[]) => send<{ changed: number; unread: number }>('POST', '/api/notifications/read', ids ? { ids } : {}),
  catchup: () => get<{ rows: CatchupRow[]; mode: string | null; canCheck: boolean }>('/api/morning/catchup'),
  catchupCheck: (ids: string[]) => send<{ results: CatchupCheck[] }>('POST', '/api/morning/catchup/check', { ids }),
  catchupSend: (ids: string[]) => send<{ results: CatchupSent[] }>('POST', '/api/morning/catchup/send', { ids }),
  catchupMark: (ids: string[], as: 'in_morning' | 'skipped', refs?: Record<string, { where: 'expense' | 'draft'; morningId: string }>) =>
    send<{ changed: number }>('POST', '/api/morning/catchup/mark', { ids, as, refs }),
  restore: (id: string) => send<Item>('POST', `/api/items/${enc(id)}/restore`),
  /** A receipt set aside because its tax invoice is on file: file it anyway. */
  keepReceipt: (id: string) => send<Item>('POST', `/api/items/${enc(id)}/keep-receipt`),
  /** Reads the document again with its vendor's current recipe (no AI). */
  reparse: (id: string) => send<{ outcome: ReparseOutcome; problems: Reason[]; item: Item }>('POST', `/api/items/${enc(id)}/reparse`),
  ingestFailures: () => get<IngestFailure[]>('/api/ingest-failures'),
  /** A photographed receipt (JPEG) or a PDF. Answers once it was read; `duplicate` points at the existing item. */
  upload: (file: Blob, name: string) =>
    send<{ id: string; duplicate: boolean; item: Item }>('POST', `/api/uploads?name=${enc(name.slice(0, 200))}`, file),

  vendors: () => get<Vendor[]>('/api/vendors'),
  setVendor: (key: string, patch: { status?: VendorStatus; defaultCategory?: string | null }) =>
    send<{ vendor: Vendor; touched: string[]; processed: boolean }>('PUT', `/api/vendors/${enc(key)}`, patch),
  recipes: (key: string) => get<RecipeVersion[]>(`/api/vendors/${enc(key)}/recipes`),
  saveRecipe: (key: string, recipe: unknown) => send<{ ok: true; id: number; reapplied: Reapplied }>('PUT', `/api/vendors/${enc(key)}/recipe`, recipe),
  /** An AI-written draft of the vendor's recipe from one of its documents; not saved. */
  regenerateRecipe: (key: string, itemId: string, comment: string) =>
    send<{ recipe: Record<string, unknown>; reproduces: boolean; check: RecipeCheck; text: string; usage: AiUsageTotals }>('POST', `/api/vendors/${enc(key)}/recipe/regenerate`, { itemId, comment }),
  testRecipe: (key: string, itemId: string, recipe: unknown) =>
    send<{ check: RecipeCheck; text: string }>('POST', `/api/vendors/${enc(key)}/recipe/test`, { itemId, recipe }),
  setAiAlways: (key: string, value: boolean) => send<{ ok: true; reapplied: Reapplied }>('PUT', `/api/vendors/${enc(key)}/ai-always`, { value }),

  backfill: (quiet = false) => get<BackfillStatus>('/api/backfill', quiet),
  /** 202: the run continues in the background; 409 backfill_running if one is already going. */
  startBackfill: () => send<{ started: true }>('POST', '/api/backfill/start'),
  approveBackfill: (ids: string[]) => send<{ ok: true }>('POST', '/api/backfill/approve', { ids }),
  skipBackfill: (ids: string[]) => send<{ skipped: number }>('POST', '/api/backfill/skip', { ids }),
  finishBackfill: () => send<{ dismissed: number }>('POST', '/api/backfill/finish'),
  /** Forgets every document and email, then runs the first import again from scratch (202, background). */
  rerunBackfill: () => send<{ started: true; cleared: { items: number; emails: number } }>('POST', '/api/backfill/rerun', { confirm: 'rerun' }),
  /** Deletes every document and email so the first import can run again (settings, vendors, recipes stay). */
  resetData: () => send<{ items: number; emails: number; unlabelled: number }>('POST', '/api/reset-data', { confirm: 'reset' }),

  missed: () => get<MissedRow[]>('/api/missed'),
  queueMissed: (id: string) => send<{ ok: true }>('POST', `/api/missed/${enc(id)}/queue`),
  hideAllMissed: () => send<{ hidden: number }>('POST', '/api/missed/hide-all'),
  hideMissed: (id: string) => send<{ ok: true }>('POST', `/api/missed/${enc(id)}/hide`),

  settings: () => get<SettingsResponse>('/api/settings'),
  saveSettings: (patch: Partial<Settings>) => send<SettingsResponse>('PUT', '/api/settings', patch),
  /** Write-only: the value is never returned by any endpoint. */
  setSecret: (key: SecretKey, value: string) => send<{ key: string; configured: true }>('PUT', `/api/secrets/${key}`, { value }),
  /** The shared Telegram bot this instance is connected to (through the hub in settings.telegramRelayUrl). */
  relayStatus: () => get<RelayStatus>('/api/telegram/relay'),
  /** A pairing link to open in Telegram; valid for a few minutes, one use. */
  relayConnect: (invite?: string) => send<{ url: string; expiresAt: string }>('POST', '/api/telegram/relay/connect', invite ? { invite } : {}),
  relayUnlink: (chatId: string) => del<{ ok: true }>(`/api/telegram/relay/chats/${enc(chatId)}`),
  testTelegram: () => send<{ ok: boolean; username?: string; error?: string }>('POST', '/api/telegram/test'),
  aiUsage: () => get<AiUsageSummary>('/api/ai/usage'),
  testAi: () => send<{ ok: boolean; provider: string; error?: string }>('POST', '/api/ai/test'),
  detectMorning: () => send<{ modes: MorningModes; verified: false }>('POST', '/api/morning/detect'),
  morningClassifications: () => get<{ classifications: MorningClassification[] }>('/api/morning/classifications'),
  /** Subfolders of a path in the chosen cloud ('' = the top). 404 folder_not_found when it does not exist. */
  storageFolders: (path: string) => get<{ path: string; folders: { name: string; path: string }[] }>(`/api/storage/folders?path=${enc(path)}`),
  /** Creates a folder in the chosen cloud now; 409 folder_conflict when a file has that name. */
  createStorageFolder: (parent: string, name: string) =>
    send<{ folder: { name: string; path: string } }>('POST', '/api/storage/folders', { parent, name }),
  gmailLabels: () => get<{ labels: string[] }>('/api/gmail/labels'),
  gmailSuggestions: () => get<GmailSuggestions>('/api/gmail/suggestions'),
};

/**
 * Starts an OAuth flow. The start route redirects to the provider; probing it first with `redirect: 'manual'`
 * lets us show a Hebrew error (e.g. missing env) instead of navigating to a raw JSON page.
 */
export async function startOAuth(url: string): Promise<void> {
  let res: Response;
  try { res = await fetch(url, { credentials: 'same-origin', redirect: 'manual' }); } catch { throw new ApiError(0, 'network'); }
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) { window.location.href = url; return; }
  const data = await res.json().catch(() => ({})) as { error?: string };
  throw new ApiError(res.status, data.error ?? 'generic');
}

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/** Each cloud's refresh-token secret; only the chosen one is ever connected. */
export const STORAGE_SECRET = { dropbox: 'dropbox_refresh', gdrive: 'gdrive_refresh' } as const satisfies Record<StorageProvider, SecretKey>;
/** Whether the chosen cloud is connected. */
export function storageConnected(s: SettingsResponse): boolean {
  return s.secrets[STORAGE_SECRET[s.settings.storageProvider]];
}
