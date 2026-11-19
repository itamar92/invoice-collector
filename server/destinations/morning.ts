import type { AccountingDestination, ExtractedFields } from '../core/types.js';
import { AccountingRejected, TransientError } from '../core/types.js';
import type { Category, Settings } from '../settings.js';
import { getSettings as defaultGetSettings } from '../settings.js';
import { getSecret } from '../secrets.js';

/** Endpoints and their provenance: docs/morning-api.md. No approve/report/confirm endpoint is ever called. */
const DEFAULT_BASE = 'https://api.greeninvoice.co.il/api/v1';
/**
 * Morning API v2 hosts. Production serves the OAuth login and the file-upload URL from one host; the sandbox splits
 * them (login https://api.sandbox.morning.dev, upload https://api.sandbox.d.greeninvoice.co.il), hence two settings.
 */
const DEFAULT_GATEWAY = 'https://api.morning.co';
const DRAFT_LOOKBACK_DAYS = 7;

export type Mailer = (to: string, subject: string, filename: string, pdf: Buffer) => Promise<string>;

export interface MorningOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** OAuth login host (env MORNING_GATEWAY_URL). */
  gatewayUrl?: string;
  /** File-upload URL host (env MORNING_UPLOAD_URL); defaults to the gateway. */
  uploadUrl?: string;
  mailer?: Mailer;
  getSettings?: () => Settings;
  now?: () => Date;
}

interface Resp { status: number; body: any }

/** Pre-signed upload target returned by GET /file-upload/v1/url. */
interface Presign { url: string; fields: Record<string, string>; maxFileSize?: number }

class Client {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(private f: typeof fetch, private base: string, private gateway: string, private uploadHost: string, private now: () => Date) {}

  private async raw(method: string, url: string, headers: Record<string, string>, payload?: unknown): Promise<Resp> {
    let res: Response;
    try {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      res = await this.f(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body });
    } catch (e) {
      throw new TransientError(`Morning unreachable: ${(e as Error).message}`);
    }
    const text = await res.text().catch(() => '');
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { errorMessage: `Morning returned an unexpected response (status ${res.status})` }; }
    return { status: res.status, body };
  }

  private remember(value: string, expiresAtMs: number): string {
    this.token = { value, expiresAt: expiresAtMs };
    return value;
  }

  /**
   * OAuth client_credentials (API v2) first; the legacy POST /account/token only when the IDP is unreachable or
   * refuses the keys (older keys may still be legacy-only). Both refusing = credentials rejected.
   */
  private async auth(): Promise<string> {
    const t = this.token;
    if (t && t.expiresAt > this.now().getTime() + 30_000) return t.value;
    const id = getSecret('morning_id');
    const secret = getSecret('morning_secret');
    if (!id || !secret) throw new AccountingRejected('Morning credentials are not configured');
    const fallbackExpiry = () => this.now().getTime() + 50 * 60_000;

    let o: Resp | null = null;
    try {
      o = await this.raw('POST', this.gateway + '/idp/v1/oauth/token', {},
        { grant_type: 'client_credentials', client_id: id, client_secret: secret });
    } catch { /* IDP unreachable: try legacy */ }
    if (o && (o.status === 429 || o.status >= 500)) throw new TransientError(`Morning auth ${o.status}`);
    if (o && o.status >= 200 && o.status < 300) {
      const tok = o.body?.accessToken ?? o.body?.access_token;
      if (!tok) throw new TransientError('Morning auth returned no token');
      const exp = typeof o.body.expiresAt === 'number' ? o.body.expiresAt * 1000
        : typeof o.body.expires_in === 'number' ? this.now().getTime() + o.body.expires_in * 1000 : fallbackExpiry();
      return this.remember(String(tok), exp);
    }

    const r = await this.raw('POST', this.base + '/account/token', {}, { id, secret });
    if (r.status === 401 || r.status === 403 || (r.status === 404 && o)) throw new AccountingRejected('Morning credentials rejected');
    const mapped = mapStatus(r);
    if (mapped) throw mapped;
    if (!r.body?.token) throw new TransientError('Morning auth returned no token');
    return this.remember(r.body.token, r.body.expires ? r.body.expires * 1000 : fallbackExpiry());
  }

  /** Authenticated POST on the API base; returns the JSON body of a 2xx, else throws Transient/Rejected. */
  post(path: string, payload: unknown): Promise<any> { return this.call('POST', this.base + path, payload); }

  /** Authenticated GET (no body) on the API base; same error mapping as post. */
  get(path: string): Promise<any> { return this.call('GET', this.base + path); }

  /** Authenticated GET on the v2 file-upload host. */
  getUpload(path: string): Promise<any> { return this.call('GET', this.uploadHost + path); }

  private async call(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<any> {
    const token = await this.auth();
    const r = await this.raw(method, url, { Authorization: `Bearer ${token}` }, payload);
    if (r.status === 401) {
      this.token = null; // auth may be momentary: caller's retry re-authenticates
      throw new TransientError('Morning returned 401');
    }
    const err = mapStatus(r);
    if (err) throw err;
    return r.body;
  }

  /**
   * Step 2 of the upload: multipart POST straight to the pre-signed S3 URL (no Morning auth header). Every presigned
   * field goes in verbatim and the file goes LAST, or S3 refuses it. An expired presign (403) is transient: the
   * retry asks for a fresh one.
   */
  async uploadPresigned(p: Presign, pdf: Buffer, filename: string): Promise<void> {
    const form = new FormData();
    for (const [k, v] of Object.entries(p.fields)) form.append(k, String(v));
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
    let res: Response;
    try {
      res = await this.f(p.url, { method: 'POST', body: form });
    } catch (e) {
      throw new TransientError(`Morning upload unreachable: ${(e as Error).message}`);
    }
    if (res.ok) return;
    const text = await res.text().catch(() => '');
    if (/EntityTooLarge/.test(text)) throw new AccountingRejected('PDF is larger than Morning accepts');
    throw new TransientError(`Morning upload failed (${res.status})`);
  }
}

function mapStatus(r: Resp): Error | null {
  if (r.status >= 200 && r.status < 300) return null;
  if (r.status === 429 || r.status >= 500) return new TransientError(`Morning ${r.status}`);
  return new AccountingRejected(String(r.body?.errorMessage ?? r.body?.message ?? r.body?.error_description ?? `Morning rejected the request (${r.status})`));
}

type HostOptions = Pick<MorningOptions, 'fetchImpl' | 'baseUrl' | 'gatewayUrl' | 'uploadUrl'>;

function makeClient(opts: HostOptions, now: () => Date): Client {
  const trim = (u: string) => u.replace(/\/+$/, '');
  const gateway = trim(opts.gatewayUrl ?? process.env.MORNING_GATEWAY_URL ?? DEFAULT_GATEWAY);
  return new Client(
    opts.fetchImpl ?? ((...a) => fetch(...a)),
    opts.baseUrl ?? process.env.GREEN_INVOICE_BASE_URL ?? DEFAULT_BASE,
    gateway,
    trim(opts.uploadUrl ?? process.env.MORNING_UPLOAD_URL ?? gateway),
    now,
  );
}

/** The name S3 substitutes into the object key's `${filename}`: no path parts, quotes or control characters. */
function uploadName(filename: string): string {
  const base = (filename.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f"]/g, '').trim().slice(0, 120);
  const name = base || 'document.pdf';
  return /\.pdf$/i.test(name) ? name : name + '.pdf';
}

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

export class MorningAccounting implements AccountingDestination {
  private readonly client: Client;
  private readonly mailer?: Mailer;
  private readonly getSettings: () => Settings;
  private readonly now: () => Date;

  constructor(opts: MorningOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.client = makeClient(opts, this.now);
    this.mailer = opts.mailer;
    this.getSettings = opts.getSettings ?? defaultGetSettings;
  }

  async send(item: { pdf: Buffer; filename: string; fields: ExtractedFields; category: Category; retry?: boolean }):
    Promise<{ ref: string; mode: 'api_fields' | 'api_file' | 'email' }> {
    const { mode, inboxEmail } = this.getSettings().morning;
    if (mode === 'email') return this.sendEmail(item, inboxEmail);
    if (mode === 'api_fields' || mode === 'api_file') return this.sendFile(item);
    throw new AccountingRejected('Morning destination mode is not configured');
  }

  private async sendEmail(item: { pdf: Buffer; filename: string }, inbox: string | undefined) {
    if (!inbox) throw new AccountingRejected('no Morning inbox email configured');
    if (!this.mailer) throw new AccountingRejected('no mailer configured for Morning email mode');
    const ref = await this.mailer(inbox, item.filename.replace(/\.pdf$/i, ''), item.filename, item.pdf);
    return { ref, mode: 'email' as const };
  }

  /**
   * api_fields cannot be done safely (docs/morning-api.md): the v2 API has no way to give a draft our fields, and
   * POST /expenses makes an approved expense. So both API modes upload the PDF as a draft and Morning reads it itself.
   *
   * v2 two-step upload: GET /file-upload/v1/url (data {"source":5} = new draft) returns a 60-second pre-signed S3
   * POST; the PDF goes there. S3 answers 204 and Morning creates the draft asynchronously, so there is no draft id
   * yet: the ref is the uploaded object's key.
   */
  private async sendFile(item: { pdf: Buffer; filename: string; fields: ExtractedFields; retry?: boolean }) {
    // R16: a retry after a timeout must not create a second draft. Only a retry looks: on a first send any
    // matching draft belongs to another document.
    const existing = item.retry ? await this.findRecentDraft(item.fields) : null;
    if (existing) return { ref: existing, mode: 'api_file' as const };
    const data = encodeURIComponent(JSON.stringify({ source: 5 }));
    const p = await this.client.getUpload(`/file-upload/v1/url?context=expense&data=${data}`);
    if (typeof p?.url !== 'string' || !/^https:\/\//.test(p.url) || !p.fields || typeof p.fields !== 'object') {
      throw new TransientError('Morning returned no upload URL');
    }
    if (typeof p.maxFileSize === 'number' && item.pdf.length > p.maxFileSize) {
      throw new AccountingRejected(`PDF is larger than Morning accepts (${Math.floor(p.maxFileSize / 1_048_576)} MB)`);
    }
    const name = uploadName(item.filename);
    await this.client.uploadPresigned(p as Presign, item.pdf, name);
    const key = typeof p.fields.key === 'string' ? p.fields.key.replace('${filename}', name) : '';
    return { ref: key || `upload:${this.now().toISOString()}`, mode: 'api_file' as const };
  }

  /** A recent draft that is provably this document: same number, same amount and same supplier. */
  private async findRecentDraft(f: ExtractedFields): Promise<string | null> {
    if (!f.docNumber || f.total === null) return null;
    const from = new Date(this.now().getTime() - DRAFT_LOOKBACK_DAYS * 86_400_000);
    const out = await this.client.post('/expenses/drafts/search', { fromDate: ymd(from), page: 1, pageSize: 100 });
    const hit = (out?.items ?? []).find((d: any) => isSameDocument(d?.expense, f));
    return hit?.id ? String(hit.id) : null;
  }
}

const digits = (s: unknown) => (typeof s === 'string' || typeof s === 'number' ? String(s).replace(/\D/g, '') : '');
const normName = (s: unknown) =>
  typeof s === 'string' ? s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '') : '';

function isSameDocument(e: any, f: ExtractedFields): boolean {
  if (!e || String(e.number ?? '') !== f.docNumber) return false;
  if (typeof e.amount !== 'number' || f.total === null || Math.abs(e.amount - f.total) > 0.005) return false;
  const s = e.supplier ?? {};
  const taxId = digits(s.taxId);
  if (taxId !== '' && taxId === digits(f.vendorTaxId)) return true;
  const name = normName(s.name);
  return name !== '' && name === normName(f.vendorName);
}

/** api_fields is unconfirmed (docs/morning-api.md) so always false; api_file needs a working read-only drafts search. */
export async function detectMorningModes(opts: HostOptions = {}):
  Promise<{ api_fields: boolean; api_file: boolean }> {
  const client = makeClient(opts, () => new Date());
  try {
    await client.post('/expenses/drafts/search', { page: 1, pageSize: 1 });
    return { api_fields: false, api_file: true };
  } catch {
    return { api_fields: false, api_file: false };
  }
}

/** One selectable Morning expense category ("accounting classification"). `id` is what an expense's accountingClassification takes. */
export interface MorningClassification {
  id: string;
  title: string;
  key: string | null;
  code: string | null;
  irsCode: number | null;
  type: number | null;
  income: number | null;
  vat: number | null;
}

/**
 * Read-only: every accounting classification (expense category) on the business, via
 * GET /accounting/classifications/map (docs/morning-api.md). The map nests classifications inside groups, so the
 * whole tree is walked; group nodes and entries without an id are skipped, duplicates collapse by id.
 */
export async function fetchMorningClassifications(opts: HostOptions = {}):
  Promise<MorningClassification[]> {
  const client = makeClient(opts, () => new Date());
  const out = new Map<string, MorningClassification>();
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    const o = v as Record<string, unknown>;
    const title = str(o.title) ?? str(o.name);
    if (typeof o.id === 'string' && o.id && title && o.group !== true && !out.has(o.id)) {
      out.set(o.id, {
        id: o.id, title, key: str(o.key), code: str(o.code), irsCode: num(o.irsCode),
        type: num(o.type), income: num(o.income), vat: num(o.vat),
      });
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(await client.get('/accounting/classifications/map'), 0);
  return [...out.values()].sort((a, b) => a.title.localeCompare(b.title, 'he'));
}
