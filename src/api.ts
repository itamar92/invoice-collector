import type { ExtractedFields, ItemState, Reason } from '../server/core/types.js';
import type { Category, Settings } from '../server/settings.js';
import type { SecretKey } from '../server/secrets.js';
import { tDyn } from './i18n/he.js';

export type { Category, ExtractedFields, ItemState, Reason, SecretKey, Settings };

export interface Summary {
  attention: number; awaitingVendor: number; waitingAi: number; worthALook: number; missedOpen: number;
  ingestFailures: number; lastTickAt: string | null; lastTickError: string | null; lastAiSuccessAt: string | null;
}

export interface Item {
  id: string; messageId: string; attachmentName: string | null; hasPdf: boolean; state: ItemState;
  reason: Reason | null; fields: ExtractedFields | null; provenance: 'recipe' | 'ai' | 'manual' | null;
  vendorKey: string | null; recipeFailed: boolean; storagePath: string | null; accountingRef: string | null;
  accountingMode: string | null; attempts: number; createdAt: string; updatedAt: string;
}
export interface ItemEvent { at: string; from: string | null; to: string; note: string | null }
/** emailMode 'backfill': the item can be filed but is never sent to Morning, so the UI offers no "send". */
export type ItemDetail = Item & { events: ItemEvent[]; emailMode: 'ongoing' | 'backfill' | 'manual' | null };

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
}
export interface MissedRow {
  messageId: string; sender: string | null; subject: string | null; receivedAt: string | null;
  foundAt: string; status: 'open' | 'queued' | 'hidden';
}
export interface IngestFailure { messageId: string; mode: string; error: string; attempts: number; firstAt: string; lastAt: string }

export type MorningModes = { api_fields: boolean; api_file: boolean };
export interface SettingsResponse { settings: Settings; secrets: Record<SecretKey, boolean>; morningModes: MorningModes | null }

/** A failed API call; `message` is already Hebrew. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, readonly body: Record<string, unknown> = {}) {
    super(tDyn(`error.${code}`, 'error.generic'));
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void { onUnauthorized = fn; }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
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

const get = <T>(p: string) => request<T>('GET', p);
const send = <T>(m: 'POST' | 'PUT', p: string, b: unknown = {}) => request<T>(m, p, b);
const enc = encodeURIComponent;

export const api = {
  login: (password: string) => send<void>('POST', '/api/login', { password }),
  logout: () => send<void>('POST', '/api/logout'),
  me: () => get<{ ok: true }>('/api/me'),
  summary: () => get<Summary>('/api/summary'),
  runWorker: () => send<Summary>('POST', '/api/worker/run'),

  items: (q: { state?: ItemState; q?: string; worth?: boolean; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.state) p.set('state', q.state);
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
  ingestFailures: () => get<IngestFailure[]>('/api/ingest-failures'),

  vendors: () => get<Vendor[]>('/api/vendors'),
  setVendor: (key: string, patch: { status?: VendorStatus; defaultCategory?: string | null }) =>
    send<{ vendor: Vendor; touched: string[]; processed: boolean }>('PUT', `/api/vendors/${enc(key)}`, patch),
  recipes: (key: string) => get<RecipeVersion[]>(`/api/vendors/${enc(key)}/recipes`),
  saveRecipe: (key: string, recipe: unknown) => send<{ ok: true; id: number }>('PUT', `/api/vendors/${enc(key)}/recipe`, recipe),
  setAiAlways: (key: string, value: boolean) => send<{ ok: true }>('PUT', `/api/vendors/${enc(key)}/ai-always`, { value }),

  backfill: () => get<BackfillStatus>('/api/backfill'),
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
  testAi: () => send<{ ok: boolean; provider: string; error?: string }>('POST', '/api/ai/test'),
  detectMorning: () => send<{ modes: MorningModes; verified: false }>('POST', '/api/morning/detect'),
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
