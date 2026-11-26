import { getDb } from '../db.js';
import { getSecret } from '../secrets.js';
import { getSettings } from '../settings.js';
import { TransientError } from '../core/types.js';
import type { Reason } from '../core/types.js';
import { createEmail, createItem, createPlaceholderItem, getEmail, isTerminal, listItems } from '../core/items.js';
import { clearIngestFailure } from '../core/ingestFailures.js';
import { knownVendorSenders } from '../core/recipeStore.js';
import { ImageError, imageToPdf } from '../core/imagePdf.js';
import { LinkError, downloadPdf, findInvoiceLinks } from './links.js';
import type { DownloadOptions } from './links.js';
import { metaReceiptDocument, parseMetaReceipt } from './meta.js';

/**
 * Without a label: only mail that names a tax document (חשבונית מס, חשבונית מס קבלה, קבלה, or the English
 * invoice/receipt of foreign vendors). Any PDF attachment, or the bare word חשבונית (חשבונית עסקה, proforma),
 * is not enough. Subjects that announce a price quote or insurance papers are left out.
 */
export const NOT_INVOICE_SUBJECTS = [
  'הצעת מחיר', 'quote', 'quotation', 'proposal',
  'פוליסה', 'פוליסת', 'מסמכי ביטוח', 'הצעת ביטוח', 'חידוש ביטוח', 'דוח שנתי', 'דיווח שנתי', 'policy',
];
const subjectTerm = (s: string) => (s.includes(' ') ? `"${s}"` : s);
export const NOT_INVOICE_QUERY = NOT_INVOICE_SUBJECTS.map((s) => `-subject:${subjectTerm(s)}`).join(' ');
const INVOICE_WORDS = '"חשבונית מס" OR "קבלה" OR "tax invoice" OR invoice OR receipt';
export const INVOICE_QUERY = invoiceQuery([]);

/** The unlabelled search; `senders` (known vendors' addresses or domains) are fetched whatever they say. */
export function invoiceQuery(senders: string[]): string {
  const from = senders.map((x) => x.replace(/["\\()\s]/g, '')).filter((x) => x !== '');
  const any = from.length > 0 ? `${INVOICE_WORDS} OR from:(${from.join(' OR ')})` : INVOICE_WORDS;
  return `(${any}) ${NOT_INVOICE_QUERY} -in:sent -in:chats`;
}
export const DONE_LABEL = 'invoice-collector/done';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailMessage {
  id: string; threadId: string; sender: string; subject: string; receivedAt: string;
  pdfs: { name: string; data: Buffer }[]; html: string; text: string;
  /** JPEG/PNG attachments big enough to be a photographed or scanned invoice (see IMAGE_MIN_BYTES). */
  images?: { name: string; data: Buffer }[];
}

/** Smaller image attachments are logos, icons and signature pictures, not invoices. */
export const IMAGE_MIN_BYTES = 15 * 1024;
/** At most this many images become items per message (only when it carries no PDF). */
export const MAX_IMAGES_PER_MESSAGE = 5;

/** What the ingest functions need from Gmail; tests inject a fake. */
export interface GmailSource {
  listCandidateMessages(opts: { after: string; labelled: boolean }): Promise<string[]>;
  /** Every message id matching a Gmail search query (paged). */
  searchMessages(q: string): Promise<string[]>;
  fetchMessage(id: string): Promise<GmailMessage>;
  /** Sender, subject and date only (format=metadata): no body, no attachments. */
  fetchHeaders(id: string): Promise<{ id: string; sender: string; subject: string; receivedAt: string }>;
  /** Adds the done label; `read` also marks the message read. */
  markHandled(id: string, opts?: { read?: boolean }): Promise<void>;
  /** Takes the done label off these messages again (reset of test data). Optional: fakes may omit it. */
  unmarkHandled?(ids: string[]): Promise<void>;
  /** User label names for the setup label picker (optional: fakes may omit it). */
  listLabels?(): Promise<string[]>;
}

export interface GmailOptions { fetchImpl?: typeof fetch; now?: () => number }

interface MessagePart {
  mimeType?: string; filename?: string;
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: MessagePart[];
}

const header = (p: MessagePart | undefined, name: string): string =>
  p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

/** 'Name <A@B.c>' -> 'a@b.c' */
export function bareAddress(from: string): string {
  const m = from.match(/<([^<>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

function decodeText(buf: Buffer, contentType: string): string {
  const cs = contentType.match(/charset\s*=\s*"?([\w.:-]+)"?/i)?.[1] ?? 'utf-8';
  try { return new TextDecoder(cs).decode(buf); } catch { return buf.toString('utf8'); }
}

/** Gmail date as YYYY/MM/DD (UTC) for the `after:` operator. */
export function gmailDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
}

const quote = (s: string) => s.replace(/["\\]/g, '');

export class GmailClient implements GmailSource {
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private token: { value: string; expiresAt: number } | null = null;
  private doneLabelId: string | null = null;

  constructor(opts: GmailOptions = {}) {
    this.f = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.now = opts.now ?? Date.now;
  }

  async listCandidateMessages(opts: { after: string; labelled: boolean }): Promise<string[]> {
    let q: string;
    if (opts.labelled) {
      const label = getSettings().gmailLabel;
      if (!label) throw new Error('gmailLabel is not set');
      q = `label:"${quote(label)}" after:${opts.after}`;
    } else {
      q = `${invoiceQuery(knownVendorSenders())} after:${opts.after}`;
    }
    q += ` -label:"${DONE_LABEL}"`;
    return this.searchMessages(q);
  }

  async searchMessages(q: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, maxResults: '500' });
      if (pageToken) params.set('pageToken', pageToken);
      const r = await this.api(`${API}/messages?${params}`);
      for (const m of r?.messages ?? []) ids.push(m.id);
      pageToken = r?.nextPageToken;
    } while (pageToken);
    return ids;
  }

  async fetchHeaders(id: string) {
    const params = new URLSearchParams({ format: 'metadata' });
    for (const h of ['From', 'Subject']) params.append('metadataHeaders', h);
    const msg = await this.api(`${API}/messages/${encodeURIComponent(id)}?${params}`);
    const payload: MessagePart = msg.payload ?? {};
    return {
      id: msg.id as string,
      sender: bareAddress(header(payload, 'from')),
      subject: header(payload, 'subject'),
      receivedAt: new Date(Number(msg.internalDate) || this.now()).toISOString(),
    };
  }

  async fetchMessage(id: string): Promise<GmailMessage> {
    const msg = await this.api(`${API}/messages/${encodeURIComponent(id)}?format=full`);
    const payload: MessagePart = msg.payload ?? {};
    const pdfs: { name: string; data: Buffer }[] = [];
    const images: { name: string; data: Buffer }[] = [];
    let html = '';
    let text = '';
    const walk = async (p: MessagePart): Promise<void> => {
      const mime = (p.mimeType ?? '').toLowerCase();
      const name = p.filename ?? '';
      const isPdf = mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
      const isImage = name !== '' && (mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/png'
        || /\.(jpe?g|png)$/i.test(name));
      const body = async (): Promise<Buffer | null> => {
        let data = p.body?.data;
        if (!data && p.body?.attachmentId) {
          const a = await this.api(
            `${API}/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(p.body.attachmentId)}`);
          data = a?.data;
        }
        return data ? Buffer.from(data, 'base64url') : null;
      };
      if (isPdf && (p.body?.attachmentId || p.body?.data)) {
        const data = await body();
        if (data) pdfs.push({ name: name || `attachment-${pdfs.length + 1}.pdf`, data });
      } else if (isImage && (p.body?.size ?? 0) >= IMAGE_MIN_BYTES && images.length < MAX_IMAGES_PER_MESSAGE) {
        const data = await body();
        if (data && data.length >= IMAGE_MIN_BYTES) images.push({ name, data });
      } else if (!name && p.body?.data && (mime === 'text/html' || mime === 'text/plain')) {
        const s = decodeText(Buffer.from(p.body.data, 'base64url'), header(p, 'content-type'));
        if (mime === 'text/html' && !html) html = s;
        if (mime === 'text/plain' && !text) text = s;
      }
      for (const c of p.parts ?? []) await walk(c);
    };
    await walk(payload);
    return {
      id: msg.id, threadId: msg.threadId ?? '',
      sender: bareAddress(header(payload, 'from')),
      subject: header(payload, 'subject'),
      receivedAt: new Date(Number(msg.internalDate) || this.now()).toISOString(),
      pdfs, html, text, images,
    };
  }

  async listLabels(): Promise<string[]> {
    const list = await this.api(`${API}/labels`);
    return ((list?.labels ?? []) as { name: string; type?: string }[])
      .filter((l) => l.type !== 'system' && l.name !== DONE_LABEL)
      .map((l) => l.name)
      .sort((a, b) => a.localeCompare(b));
  }

  /** Adds the done label; with `read`, also takes off UNREAD. Never removes any other label. */
  async markHandled(id: string, opts: { read?: boolean } = {}): Promise<void> {
    const labelId = await this.ensureDoneLabel();
    await this.api(`${API}/messages/${encodeURIComponent(id)}/modify`, {
      method: 'POST', json: { addLabelIds: [labelId], ...(opts.read ? { removeLabelIds: ['UNREAD'] } : {}) },
    });
  }

  /** Removes the done label from these messages (batchModify, 1000 per call). Nothing to do if the label is gone. */
  async unmarkHandled(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const list = await this.api(`${API}/labels`);
    const found = (list?.labels ?? []).find((l: { name: string }) => l.name === DONE_LABEL);
    if (!found) return;
    for (let i = 0; i < ids.length; i += 1000) {
      await this.api(`${API}/messages/batchModify`, {
        method: 'POST', json: { ids: ids.slice(i, i + 1000), removeLabelIds: [found.id] },
      });
    }
  }

  async sendMailWithAttachment(to: string, subject: string, filename: string, pdf: Buffer): Promise<string> {
    const raw = buildMime(to, subject, filename, pdf).toString('base64url');
    const r = await this.api(`${API}/messages/send`, { method: 'POST', json: { raw } });
    return String(r?.id ?? '');
  }

  private async ensureDoneLabel(): Promise<string> {
    if (this.doneLabelId) return this.doneLabelId;
    const list = await this.api(`${API}/labels`);
    const found = (list?.labels ?? []).find((l: { name: string }) => l.name === DONE_LABEL);
    if (found) return (this.doneLabelId = found.id as string);
    const created = await this.api(`${API}/labels`, {
      method: 'POST',
      json: { name: DONE_LABEL, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    });
    return (this.doneLabelId = created.id as string);
  }

  /** One API call; on 401 refreshes the token once and retries once. 429/5xx/network -> TransientError. */
  private async api(url: string, opts: { method?: string; json?: unknown } = {}): Promise<any> {
    let res = await this.attempt(url, opts, await this.accessToken());
    if (res.status === 401) {
      this.token = null;
      res = await this.attempt(url, opts, await this.accessToken());
    }
    if (res.status >= 200 && res.status < 300) return res.body;
    const msg = `Gmail ${res.status}: ${res.body?.error?.message ?? 'error'}`;
    if (res.status === 429 || res.status >= 500) throw new TransientError(msg);
    throw new Error(msg);
  }

  private async attempt(url: string, opts: { method?: string; json?: unknown }, token: string) {
    let res: Response;
    try {
      res = await this.f(url, {
        method: opts.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
      });
    } catch (e) {
      throw new TransientError(`Gmail network error: ${(e as Error).message}`);
    }
    const text = await res.text().catch(() => '');
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { error: { message: text.slice(0, 200) } }; }
    return { status: res.status, body };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - 60_000) return this.token.value;
    const refresh = getSecret('gmail_refresh');
    if (!refresh) throw new Error('Gmail is not connected');
    const id = process.env.GOOGLE_CLIENT_ID;
    const secret = process.env.GOOGLE_CLIENT_SECRET;
    if (!id || !secret) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set');
    let res: Response;
    try {
      res = await this.f('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: refresh, client_id: id, client_secret: secret,
        }).toString(),
      });
    } catch (e) { throw new TransientError(`Gmail network error: ${(e as Error).message}`); }
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status >= 500) throw new TransientError(`Google token refresh ${res.status}`);
    if (res.status !== 200 || typeof body?.access_token !== 'string') {
      throw new Error(`Google token refresh failed (${res.status}): ${body?.error_description ?? body?.error ?? 'error'}`);
    }
    this.token = { value: body.access_token, expiresAt: this.now() + (Number(body.expires_in) || 3600) * 1000 };
    return this.token.value;
  }
}

const noCrlf = (s: string) => s.replace(/[\r\n]+/g, ' ');
const b64Lines = (b: Buffer) => (b.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');

/** RFC 2047 encoded-word for a header value (Hebrew subjects). */
function encodeWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

export function buildMime(to: string, subject: string, filename: string, pdf: Buffer): Buffer {
  const boundary = `ic_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const ascii = noCrlf(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'document.pdf';
  const star = encodeURIComponent(noCrlf(filename)).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const lines = [
    `To: ${noCrlf(to)}`,
    `Subject: ${encodeWord(noCrlf(subject))}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${ascii}"; name*=UTF-8''${star}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${star}`,
    '',
    b64Lines(pdf),
    `--${boundary}--`,
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

/** PDF magic: `%PDF-` within the first 1024 bytes (readers tolerate a short preamble). */
export function isPdf(data: Buffer): boolean {
  return Buffer.isBuffer(data) && data.subarray(0, 1024).includes('%PDF-', 0, 'latin1');
}

/** `photo.jpg` -> `photo.pdf` */
function pdfName(name: string): string {
  return `${name.replace(/\.(jpe?g|png)$/i, '') || 'image'}.pdf`;
}

/**
 * Ingests one Gmail message: PDFs become items; with no PDF attachment, a Meta ads receipt email gets Meta's
 * PDF or one built from the email (see meta.ts), other emails have their invoice links downloaded, and only
 * when no link gives a PDF do JPEG/PNG attachments become one-page PDFs;
 * if nothing usable is found a placeholder item keeps the email visible. Already-ingested ids are skipped.
 */
export async function ingestMessage(
  gmail: GmailSource, id: string, mode: 'ongoing' | 'backfill' | 'manual', downloadOpts?: DownloadOptions,
): Promise<{ skipped: boolean; items: number }> {
  if (getEmail(id) && listItems({ messageId: id, limit: 1 }).length > 0) {
    clearIngestFailure(id);
    return { skipped: true, items: 0 };
  }
  const msg = await gmail.fetchMessage(id);
  // An attachment called .pdf that is not one (no %PDF- header) is never stored as a document.
  let pdfs: { name: string; data: Buffer; note?: string }[] = msg.pdfs.filter((p) => isPdf(p.data));
  const notPdf = msg.pdfs.filter((p) => !isPdf(p.data));
  let failure: Reason | null = null;
  let failureDetail: string | undefined;
  if (msg.pdfs.length === 0) {
    // No PDF attached: the invoice is behind a link (Meta, Morning, Kvish 6...). Links go before images, since
    // an email that links its invoice usually also carries a banner or logo image that is not the invoice.
    const meta = parseMetaReceipt(msg.html);
    if (meta) {
      pdfs = [await metaReceiptDocument(meta, msg.receivedAt, downloadOpts)];
    } else {
      for (const url of findInvoiceLinks(msg.html, msg.text)) {
        try {
          pdfs.push({ name: 'link.pdf', data: await downloadPdf(url, downloadOpts) });
          break; // R20: the first successful PDF wins
        } catch (e) {
          if (!failure) {
            failure = e instanceof LinkError ? e.code : 'link_failed';
            failureDetail = `${linkHost(url)} - ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      }
    }
    if (pdfs.length === 0) {
      for (const img of msg.images ?? []) {
        try { pdfs.push({ name: pdfName(img.name), data: imageToPdf(img.data) }); } catch (e) {
          if (!(e instanceof ImageError)) throw e;
          notPdf.push(img); // a broken image stays visible as a placeholder, like a fake .pdf
        }
      }
    }
    if (pdfs.length === 0 && notPdf.length === 0) failure ??= 'no_document';
  }
  // All-or-nothing: an email row without its items must never persist.
  return getDb().transaction(() => {
    clearIngestFailure(id);
    createEmail({
      messageId: id, threadId: msg.threadId, sender: msg.sender, subject: msg.subject,
      receivedAt: msg.receivedAt, mode,
    });
    for (const p of notPdf) createPlaceholderItem(id, 'no_document', p.name);
    if (pdfs.length === 0 && notPdf.length === 0) {
      createPlaceholderItem(id, failure ?? 'no_document', null, failureDetail);
      return { skipped: false, items: 1 };
    }
    for (const p of pdfs) createItem(id, p.name, p.data, p.note);
    return { skipped: false, items: pdfs.length + notPdf.length };
  })();
}

const linkHost = (url: string) => { try { return new URL(url).hostname; } catch { return 'link'; } };

/**
 * Labels the Gmail message once every item for it is terminal. Idempotent. A message whose invoice was collected
 * (an item reached done) is also marked read, so the inbox shows what was taken care of; one where nothing was
 * collected stays unread.
 */
export async function markHandledIfComplete(gmail: GmailSource, messageId: string): Promise<boolean> {
  const email = getEmail(messageId);
  if (!email || email.gmailMarked) return false;
  const items = listItems({ messageId, limit: 1000 });
  if (items.length === 0 || !items.every((i) => isTerminal(i.state))) return false;
  await gmail.markHandled(messageId, { read: items.some((i) => i.state === 'done') });
  getDb().prepare('UPDATE emails SET gmail_marked = 1 WHERE message_id = ?').run(messageId);
  return true;
}
