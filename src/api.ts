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
}

export interface Item {
  id: string; messageId: string; attachmentName: string | null; hasPdf: boolean; state: ItemState;
  reason: Reason | null; fields: ExtractedFields | null; provenance: 'recipe' | 'ai' | 'manual' | null;
  vendorKey: string | null; recipeFailed: boolean; storagePath: string | null; accountingRef: string | null;
  accountingMode: string | null; attempts: number; createdAt: string; updatedAt: string;
  /** Lists only: the document's text was extracted (a recipe can be written from it). */
  hasText?: boolean;
}
/** Calls and tokens over some AI calls; `unknownCalls` reported no token counts (SSH agent). */
export interface AiUsageTotals { calls: number; inputTokens: number; outputTokens: number; unknownCalls: number }
export interface AiUsageSummary { today: AiUsageTotals; month: AiUsageTotals; total: AiUsageTotals; backfill: AiUsageTotals }
/** After a recipe change: the vendor's unfiled documents read again with it. */
export interface Reapplied { checked: number; updated: number }
export interface ItemEvent { at: string; from: string | null; to: string; note: string | null }
/** emailMode 'backfill': the item can be filed but is never sent to Morning, so the UI offers no "send". */
export type ItemDetail = Item & {
  events: ItemEvent[]; emailMode: 'ongoing' | 'backfill' | 'manual' | null; hasText: boolean; aiUsage: AiUsageTotals;
};

export type VendorStatus = 'business' | 'personal' | 'ignored' | 'unreviewed';
export interface Vendor { key: string; displayName: string; status: VendorStatus; defaultCategory: string | null; createdAt: string }
export interface RecipeVersion { version: number; source: 'starter' | 'ai' | 'user'; createdAt: string; recipe: Record<string, unknown> & { aiAlways?: boolean } }

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
  login: (password: string) => send<void>('POST', '/api/login', { password }),
  logout: () => send<void>('POST', '/api/logout'),
  me: () => get<{ ok: true }>('/api/me'),
  /** `quiet`: the periodic refresh, without the loading bar. */
  summary: (quiet = false) => get<Summary>('/api/summary', quiet),
  stats: (year?: number) => get<Stats>(`/api/stats${year ? `?year=${year}` : ''}`),
  runWorker: () => send<Summary>('POST', '/api/worker/run'),

  items: (q: { state?: ItemState; q?: string; worth?: boolean; vendor?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.state) p.set('state', q.state);
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
  retry: (id: string) => send<Item>('POST', `/api/items/${enc(id)}/retry`),
  dismiss: (id: string) => send<Item>('POST', `/api/items/${enc(id)}/dismiss`),
  /** A receipt set aside because its tax invoice is on file: file it anyway. */
  keepReceipt: (id: string) => send<Item>('POST', `/api/items/${enc(id)}/keep-receipt`),
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
    send<{ recipe: Record<string, unknown>; reproduces: boolean; usage: AiUsageTotals }>('POST', `/api/vendors/${enc(key)}/recipe/regenerate`, { itemId, comment }),
  setAiAlways: (key: string, value: boolean) => send<{ ok: true; reapplied: Reapplied }>('PUT', `/api/vendors/${enc(key)}/ai-always`, { value }),

  backfill: (quiet = false) => get<BackfillStatus>('/api/backfill', quiet),
  /** 202: the run continues in the background; 409 backfill_running if one is already going. */
  startBackfill: () => send<{ started: true }>('POST', '/api/backfill/start'),
  approveBackfill: (ids: string[]) => send<{ ok: true }>('POST', '/api/backfill/approve', { ids }),
  skipBackfill: (ids: string[]) => send<{ skipped: number }>('POST', '/api/backfill/skip', { ids }),
  finishBackfill: () => send<{ dismissed: number }>('POST', '/api/backfill/finish'),

  missed: () => get<MissedRow[]>('/api/missed'),
  queueMissed: (id: string) => send<{ ok: true }>('POST', `/api/missed/${enc(id)}/queue`),
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
