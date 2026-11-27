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

  /** Authenticated DELETE on the API base; the raw status and body, so the caller can tell "not supported". */
  async del(path: string): Promise<Resp> {
    const token = await this.auth();
    const r = await this.raw('DELETE', this.base + path, { Authorization: `Bearer ${token}` });
    if (r.status === 401) this.token = null;
    return r;
  }

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
  private readonly lookup: MorningLookup;

  constructor(opts: MorningOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.client = makeClient(opts, this.now);
    this.mailer = opts.mailer;
    this.getSettings = opts.getSettings ?? defaultGetSettings;
    this.lookup = new MorningLookup({ ...opts, now: this.now });
  }

  /**
   * Before a send: is this document already an expense or a pending draft in Morning? Read-only, needs API keys
   * (email mode without keys cannot look: null). Matching rules: compare() (same number + amount + supplier = found).
   */
  async findExisting(fields: ExtractedFields): Promise<MorningMatch | null> {
    if (!getSecret('morning_id') || !getSecret('morning_secret')) return null;
    return this.lookup.find(fields);
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

  /**
   * Takes back a draft we uploaded. Never touches an approved expense (that is the owner's bookkeeping: they delete it
   * in Morning). The draft is found by the uploaded file's key (our ref), else as provably the same document, and
   * deleted with DELETE /expenses/drafts/{id}. That endpoint is not documented (docs/morning-api.md): when Morning
   * refuses it, the outcome is 'manual' and the owner deletes the draft in Morning.
   */
  async remove(sent: { ref: string; mode: string | null; fields: ExtractedFields | null }):
    Promise<{ outcome: 'removed' | 'manual'; reason?: string }> {
    if (sent.mode === 'email') return { outcome: 'manual', reason: 'sent_by_email' };
    if (sent.ref.startsWith('expense:')) return { outcome: 'manual', reason: 'approved_expense' };
    let id = sent.ref.startsWith('draft:') ? sent.ref.slice('draft:'.length) : null;
    try {
      if (!id) id = await this.findDraftFor(sent.ref, sent.fields);
      if (!id) return { outcome: 'manual', reason: 'draft_not_found' };
      const r = await this.client.del(`/expenses/drafts/${encodeURIComponent(id)}`);
      if (r.status >= 200 && r.status < 300) return { outcome: 'removed' };
      if (r.status === 404 || r.status === 405) return { outcome: 'manual', reason: 'delete_not_supported' };
      return { outcome: 'manual', reason: String(r.body?.errorMessage ?? `Morning ${r.status}`).slice(0, 200) };
    } catch (e) {
      return { outcome: 'manual', reason: (e as Error).message.slice(0, 200) };
    }
  }

  /** The draft holding the file uploaded under `key`, else one provably the same document. */
  private async findDraftFor(key: string, f: ExtractedFields | null): Promise<string | null> {
    const from = new Date(this.now().getTime() - 400 * 86_400_000);
    const name = key.slice(key.lastIndexOf('/') + 1);
    let same: string | null = null;
    for (let page = 1; page <= 20; page++) {
      const out = await this.client.post('/expenses/drafts/search', { fromDate: ymd(from), page, pageSize: 100 });
      const items: any[] = Array.isArray(out?.items) ? out.items : [];
      for (const d of items) {
        const fileKey = typeof d?.expense?.fileKey === 'string' ? d.expense.fileKey : '';
        if (d?.id && fileKey && (fileKey === key || key.endsWith(fileKey) || fileKey.endsWith(key) || (name && fileKey.endsWith(name)))) {
          return String(d.id);
        }
        if (!same && d?.id && f && isSameDocument(d?.expense, f)) same = String(d.id);
      }
      if (items.length < 100 || (typeof out?.pages === 'number' && page >= out.pages)) break;
    }
    return same;
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

/** What Morning already holds for one of our documents (catch-up send after the first import). */
export interface MorningMatch {
  /** found: same number, amount and supplier. maybe: two of the three agree. not_found: nothing close.
   *  unknown: our document has neither a number nor a total, so nothing can be compared. */
  status: 'found' | 'maybe' | 'not_found' | 'unknown';
  where?: 'expense' | 'draft';
  morningId?: string;
  /** What Morning holds, so the owner can judge a "maybe". */
  seen?: { number: string | null; amount: number | null; supplier: string | null; date: string | null };
}

/** Morning expense statuses that no longer count (100 = deleted); draft statuses 50 failed and 200 declined. */
const DEAD_EXPENSE = new Set([100]);
const DEAD_DRAFT = new Set([50, 200]);
const DRAFT_LOOKUP_DAYS = 400;
const DRAFT_PAGES = 20;
const DRAFT_CACHE_MS = 5 * 60_000;

/** Document numbers compared loosely: case, spacing, punctuation and leading zeros do not matter. */
const normNumber = (s: unknown) =>
  typeof s === 'string' || typeof s === 'number' ? String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').replace(/^0+(?=\d)/, '') : '';

function compare(e: any, f: ExtractedFields): 'found' | 'maybe' | null {
  if (!e) return null;
  const ourNum = normNumber(f.docNumber);
  const num = ourNum !== '' && normNumber(e.number) === ourNum;
  const amount = typeof e.amount === 'number' && f.total !== null && Math.abs(e.amount - f.total) <= 0.01;
  const s = e.supplier ?? {};
  const taxId = digits(s.taxId);
  const supplier = (taxId !== '' && taxId === digits(f.vendorTaxId))
    || (normName(s.name) !== '' && normName(s.name) === normName(f.vendorName));
  const date = typeof e.date === 'string' && !!f.issueDate && e.date.slice(0, 10) === f.issueDate;
  if (num && amount && supplier) return 'found';
  if (num && (amount || supplier)) return 'maybe';
  // Our document has no number: the same amount, day and supplier is as close as it gets.
  if (ourNum === '' && amount && supplier && date) return 'maybe';
  return null;
}

const seenOf = (e: any): MorningMatch['seen'] => ({
  number: e?.number != null ? String(e.number) : null,
  amount: typeof e?.amount === 'number' ? e.amount : null,
  supplier: typeof e?.supplier?.name === 'string' ? e.supplier.name : null,
  date: typeof e?.date === 'string' ? e.date.slice(0, 10) : null,
});

/**
 * Looks for documents in Morning before they are sent there: approved expenses (searched by document number, or by
 * supplier and amount when there is none) and recent drafts (fetched once and kept a few minutes, since the drafts
 * search cannot filter by number). Read-only. Matching rules: compare() above.
 */
export class MorningLookup {
  private readonly client: Client;
  private readonly now: () => Date;
  private drafts: { at: number; items: any[] } | null = null;

  constructor(opts: HostOptions & { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.client = makeClient(opts, this.now);
  }

  private async recentDrafts(): Promise<any[]> {
    if (this.drafts && this.now().getTime() - this.drafts.at < DRAFT_CACHE_MS) return this.drafts.items;
    const from = ymd(new Date(this.now().getTime() - DRAFT_LOOKUP_DAYS * 86_400_000));
    const items: any[] = [];
    for (let page = 1; page <= DRAFT_PAGES; page++) {
      const out = await this.client.post('/expenses/drafts/search', { fromDate: from, page, pageSize: 100 });
      const got = Array.isArray(out?.items) ? out.items : [];
      items.push(...got);
      if (got.length < 100 || (typeof out?.pages === 'number' && page >= out.pages)) break;
    }
    this.drafts = { at: this.now().getTime(), items };
    return items;
  }

  async find(f: ExtractedFields): Promise<MorningMatch> {
    if (!normNumber(f.docNumber) && f.total === null) return { status: 'unknown' };
    const query = normNumber(f.docNumber)
      ? { number: String(f.docNumber), page: 1, pageSize: 50 }
      : { supplierName: f.vendorName ?? undefined, minAmount: f.total, maxAmount: f.total, page: 1, pageSize: 50 };
    const out = await this.client.post('/expenses/search', query);
    const expenses = (Array.isArray(out?.items) ? out.items : []).filter((e: any) => !DEAD_EXPENSE.has(e?.status));
    const drafts = (await this.recentDrafts()).filter((d: any) => !DEAD_DRAFT.has(d?.status));
    let maybe: MorningMatch | null = null;
    for (const [where, list] of [['expense', expenses], ['draft', drafts]] as const) {
      for (const x of list) {
        const e = where === 'expense' ? x : x?.expense;
        const r = compare(e, f);
        if (!r) continue;
        const m: MorningMatch = { status: r, where, morningId: x?.id != null ? String(x.id) : undefined, seen: seenOf(e) };
        if (r === 'found') return m;
        maybe ??= m;
      }
    }
    return maybe ?? { status: 'not_found' };
  }
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

/** A Morning expense draft still waiting for the owner's approval (status 10 "new"). */
export interface PendingDraft {
  id: string;
  /** Unix seconds as Morning gives it, as ISO. */
  createdAt: string | null;
  number: string | null;
  date: string | null;
  reportingDate: string | null;
  amount: number | null;
  vat: number | null;
  currency: string | null;
  supplierName: string | null;
  supplierTaxId: string | null;
  documentType: number | null;
  paymentType: number | null;
  classification: string | null;
  /** Download link of the uploaded file. */
  fileUrl: string | null;
  /** Community-schema field (not in the v2 spec); used to tie a draft to our upload when present. */
  fileKey: string | null;
}

/** Our document type as Morning's expense documentType code (official v2 spec). */
export const MORNING_DOC_TYPE: Record<string, number> = {
  tax_invoice: 305, tax_invoice_receipt: 320, credit_note: 330, receipt: 400, other: 20,
};

const PENDING_DRAFT = 10;

function toPending(d: any): PendingDraft | null {
  if (!d || d.id == null || d.status !== PENDING_DRAFT) return null;
  const e = d.expense ?? {};
  const s = e.supplier ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : typeof v === 'number' ? String(v) : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const ts = typeof d.creationDate === 'number' ? new Date(d.creationDate * (d.creationDate > 1e12 ? 1 : 1000)).toISOString() : null;
  return {
    id: String(d.id), createdAt: ts,
    number: str(e.number), date: str(e.date)?.slice(0, 10) ?? null, reportingDate: str(e.reportingDate)?.slice(0, 10) ?? null,
    amount: num(e.amount), vat: num(e.vat), currency: str(e.currency),
    supplierName: str(s.name), supplierTaxId: str(s.taxId),
    documentType: num(e.documentType), paymentType: num(e.paymentType),
    classification: str(e.accountingClassification?.title),
    fileUrl: typeof d.url === 'string' && /^https:\/\//.test(d.url) ? d.url : null,
    fileKey: str(e.fileKey),
  };
}

export interface ApproveInput {
  draft: PendingDraft;
  fields: ExtractedFields;
  /** Morning accounting classification id (the category's mapping in Settings). */
  classificationId: string;
  pdf: Buffer | null;
  filename: string;
}

export interface ApproveResult {
  expenseId: string;
  /** An expense with this number, amount and supplier was already in Morning: nothing was created. */
  existed: boolean;
  /** We attached our PDF to the expense now. */
  fileAttached: boolean;
  draftRemoved: boolean;
  /** Why the draft was left in Morning (the owner removes it there). */
  draftReason?: string;
}

/** Why approving cannot start: a required Morning field is missing on both sides. */
export class ApproveBlocked extends Error {
  constructor(public readonly code: 'no_number' | 'no_date' | 'no_supplier' | 'no_amount' | 'future_date') { super(code); }
}

/**
 * The owner's approval queue in Morning: expense drafts (uploads, ours and anyone else's) waiting to be approved.
 *
 * Morning has no "approve draft" endpoint (official v2 spec, 2026-11). Approving with our details therefore means,
 * only on the owner's explicit click for one draft:
 *   1. POST /expenses/search by number: if the same expense is already there, nothing is created.
 *   2. POST /expenses with our fields and the category's classification (this creates an approved expense).
 *   3. Our PDF is attached to it: GET /file-upload/v1/url with data {id, source:5, state:"expense"} + S3 upload.
 *   4. DELETE /expenses/drafts/{id} (undocumented; a refusal leaves the draft for the owner to delete in Morning).
 * The draft is deleted only when the new expense holds the file, so a file is never lost.
 */
export class MorningDrafts {
  private readonly client: Client;
  private readonly now: () => Date;

  constructor(opts: HostOptions & { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.client = makeClient(opts, this.now);
  }

  async listPending(): Promise<PendingDraft[]> {
    const from = ymd(new Date(this.now().getTime() - DRAFT_LOOKUP_DAYS * 86_400_000));
    const out: PendingDraft[] = [];
    for (let page = 1; page <= DRAFT_PAGES; page++) {
      const r = await this.client.post('/expenses/drafts/search', { fromDate: from, page, pageSize: 100 });
      const got: any[] = Array.isArray(r?.items) ? r.items : [];
      for (const d of got) { const p = toPending(d); if (p) out.push(p); }
      if (got.length < 100 || (typeof r?.pages === 'number' && page >= r.pages)) break;
    }
    return out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  }

  /** The body POST /expenses gets: our fields first, Morning's reading of the draft where ours are missing. */
  expenseBody(input: Omit<ApproveInput, 'pdf' | 'filename'>): Record<string, unknown> {
    const { draft: d, fields: f } = input;
    const number = f.docNumber ?? d.number;
    const date = f.issueDate ?? d.date;
    const supplier = f.vendorName ?? d.supplierName;
    const amount = f.total ?? d.amount;
    if (!number) throw new ApproveBlocked('no_number');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApproveBlocked('no_date');
    if (date > ymd(this.now())) throw new ApproveBlocked('future_date');
    if (!supplier) throw new ApproveBlocked('no_supplier');
    if (amount === null) throw new ApproveBlocked('no_amount');
    // Morning proposes a VAT month (a late document lands in the open period); never earlier than the document's own.
    const docMonth = `${date.slice(0, 7)}-01`;
    const reportingDate = d.reportingDate && d.reportingDate.slice(0, 7) >= date.slice(0, 7) ? `${d.reportingDate.slice(0, 7)}-01` : docMonth;
    const taxId = digits(f.vendorTaxId) || digits(d.supplierTaxId);
    const body: Record<string, unknown> = {
      documentType: (f.docType && MORNING_DOC_TYPE[f.docType]) || d.documentType || MORNING_DOC_TYPE.tax_invoice,
      number, date, reportingDate,
      currency: f.currency ?? d.currency ?? 'ILS',
      amount,
      supplier: { name: supplier, ...(taxId ? { taxId } : {}) },
      accountingClassification: { id: input.classificationId },
    };
    const vat = f.vat ?? d.vat;
    if (vat !== null && vat !== undefined) body.vat = vat;
    if (d.paymentType !== null) body.paymentType = d.paymentType;
    if (f.description) body.description = f.description.slice(0, 200);
    if (f.allocationNumber) body.allocationNumber = f.allocationNumber;
    return body;
  }

  async approve(input: ApproveInput): Promise<ApproveResult> {
    const body = this.expenseBody(input);
    const fields: ExtractedFields = {
      ...input.fields, docNumber: String(body.number), total: body.amount as number,
      vendorName: (body.supplier as any).name, vendorTaxId: (body.supplier as any).taxId ?? null, issueDate: String(body.date),
    };
    // 1. Already approved (an earlier click whose answer was lost, or entered by hand): never a second expense.
    const found = await this.client.post('/expenses/search', { number: String(body.number), page: 1, pageSize: 50 });
    const same = (Array.isArray(found?.items) ? found.items : [])
      .find((e: any) => !DEAD_EXPENSE.has(e?.status) && compare(e, fields) === 'found');
    let expenseId: string;
    let existed = false;
    let fileAttached = false;
    let hadFile = false;
    if (same?.id != null) {
      expenseId = String(same.id);
      existed = true;
      hadFile = typeof same.url === 'string' && same.url !== '';
    } else {
      const created = await this.client.post('/expenses', body);
      if (created?.id == null) throw new TransientError('Morning created the expense but returned no id');
      expenseId = String(created.id);
    }
    // 2. Our PDF on the expense (an existing one only when it has no file yet). A failure keeps the draft, which
    //    still holds the file.
    let draftReason: string | undefined;
    if (!hadFile && input.pdf) {
      try {
        const data = encodeURIComponent(JSON.stringify({ id: expenseId, source: 5, state: 'expense' }));
        const p = await this.client.getUpload(`/file-upload/v1/url?context=expense&data=${data}`);
        if (typeof p?.url !== 'string' || !/^https:\/\//.test(p.url) || !p.fields) throw new TransientError('Morning returned no upload URL');
        await this.client.uploadPresigned(p as Presign, input.pdf, uploadName(input.filename));
        fileAttached = true;
      } catch (e) {
        draftReason = `file_not_attached: ${(e as Error).message}`.slice(0, 200);
      }
    }
    // 3. The draft goes only when the expense has a file of its own.
    let draftRemoved = false;
    if (hadFile || fileAttached) {
      try {
        const r = await this.client.del(`/expenses/drafts/${encodeURIComponent(input.draft.id)}`);
        if (r.status >= 200 && r.status < 300) draftRemoved = true;
        else draftReason = r.status === 404 || r.status === 405 ? 'delete_not_supported' : String(r.body?.errorMessage ?? `Morning ${r.status}`).slice(0, 200);
      } catch (e) {
        draftReason = (e as Error).message.slice(0, 200);
      }
    }
    return { expenseId, existed, fileAttached, draftRemoved, ...(draftReason ? { draftReason } : {}) };
  }
}
