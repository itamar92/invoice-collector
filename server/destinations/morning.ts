import type { AccountingDestination, ExtractedFields } from '../core/types.js';
import { AccountingRejected, TransientError } from '../core/types.js';
import type { Category, Settings } from '../settings.js';
import { getSettings as defaultGetSettings } from '../settings.js';
import { getSecret } from '../secrets.js';

/** Endpoints and their provenance: docs/morning-api.md. No approve/report/confirm endpoint is ever called. */
const DEFAULT_BASE = 'https://api.greeninvoice.co.il/api/v1';
const DRAFT_LOOKBACK_DAYS = 7;

export type Mailer = (to: string, subject: string, filename: string, pdf: Buffer) => Promise<string>;

export interface MorningOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  mailer?: Mailer;
  getSettings?: () => Settings;
  now?: () => Date;
}

interface Resp { status: number; body: any }

class Client {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(private f: typeof fetch, private base: string, private now: () => Date) {}

  private async raw(method: string, path: string, headers: Record<string, string>, payload: unknown): Promise<Resp> {
    let res: Response;
    try {
      res = await this.f(this.base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
    } catch (e) {
      throw new TransientError(`Morning unreachable: ${(e as Error).message}`);
    }
    const text = await res.text().catch(() => '');
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { errorMessage: `Morning returned an unexpected response (status ${res.status})` }; }
    return { status: res.status, body };
  }

  private async auth(): Promise<string> {
    const t = this.token;
    if (t && t.expiresAt > this.now().getTime() + 30_000) return t.value;
    const id = getSecret('morning_id');
    const secret = getSecret('morning_secret');
    if (!id || !secret) throw new AccountingRejected('Morning credentials are not configured');
    const r = await this.raw('POST', '/account/token', {}, { id, secret });
    if (r.status === 401 || r.status === 403) throw new AccountingRejected('Morning credentials rejected');
    const mapped = mapStatus(r);
    if (mapped) throw mapped;
    if (!r.body?.token) throw new TransientError('Morning auth returned no token');
    const expiresAt = r.body.expires ? r.body.expires * 1000 : this.now().getTime() + 50 * 60_000;
    this.token = { value: r.body.token, expiresAt };
    return r.body.token;
  }

  /** Authenticated POST; returns the JSON body of a 2xx, else throws Transient/Rejected. */
  async post(path: string, payload: unknown): Promise<any> {
    const token = await this.auth();
    const r = await this.raw('POST', path, { Authorization: `Bearer ${token}` }, payload);
    if (r.status === 401) {
      this.token = null; // auth may be momentary: caller's retry re-authenticates
      throw new TransientError('Morning returned 401');
    }
    const err = mapStatus(r);
    if (err) throw err;
    return r.body;
  }
}

function mapStatus(r: Resp): Error | null {
  if (r.status >= 200 && r.status < 300) return null;
  if (r.status === 429 || r.status >= 500) return new TransientError(`Morning ${r.status}`);
  return new AccountingRejected(String(r.body?.errorMessage ?? r.body?.message ?? `Morning rejected the request (${r.status})`));
}

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

export class MorningAccounting implements AccountingDestination {
  private readonly client: Client;
  private readonly mailer?: Mailer;
  private readonly getSettings: () => Settings;
  private readonly now: () => Date;

  constructor(opts: MorningOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.client = new Client(opts.fetchImpl ?? ((...a) => fetch(...a)), opts.baseUrl ?? process.env.GREEN_INVOICE_BASE_URL ?? DEFAULT_BASE, this.now);
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
   * api_fields cannot be done safely (docs/morning-api.md): attaching fields would need an endpoint that is not
   * known to keep the draft unconfirmed. So both API modes upload the PDF as a draft and Morning reads it itself.
   */
  private async sendFile(item: { pdf: Buffer; fields: ExtractedFields; retry?: boolean }) {
    // R16: a retry after a timeout must not create a second draft. Only a retry looks: on a first send any
    // matching draft belongs to another document.
    const existing = item.retry ? await this.findRecentDraft(item.fields) : null;
    if (existing) return { ref: existing, mode: 'api_file' as const };
    const out = await this.client.post('/expenses/file', {
      file: 'data:application/pdf;base64,' + item.pdf.toString('base64'),
    });
    if (!out?.id) throw new TransientError('Morning upload returned no draft id');
    return { ref: String(out.id), mode: 'api_file' as const };
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
export async function detectMorningModes(opts: Pick<MorningOptions, 'fetchImpl' | 'baseUrl'> = {}):
  Promise<{ api_fields: boolean; api_file: boolean }> {
  const client = new Client(opts.fetchImpl ?? ((...a) => fetch(...a)), opts.baseUrl ?? process.env.GREEN_INVOICE_BASE_URL ?? DEFAULT_BASE, () => new Date());
  try {
    await client.post('/expenses/drafts/search', { page: 1, pageSize: 1 });
    return { api_fields: false, api_file: true };
  } catch {
    return { api_fields: false, api_file: false };
  }
}
