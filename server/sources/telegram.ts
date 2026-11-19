import { getItem } from '../core/items.js';
import type { Item } from '../core/items.js';
import type { Deps } from '../core/types.js';
import { getSecret } from '../secrets.js';
import { getSettings } from '../settings.js';
import { MAX_UPLOAD_BYTES, UploadError, createUpload, runUpload } from './upload.js';

/**
 * Telegram bot: the owner sends a photo of a paper receipt (or a PDF) to the bot and it goes through the same
 * pipeline as an emailed document. Long polling (getUpdates), so no public webhook is needed. Only chats listed
 * in settings.telegramChatIds are served; any other chat is only told its own chat id.
 */

export interface TgMessage {
  message_id: number;
  chat: { id: number; first_name?: string; last_name?: string; title?: string; username?: string };
  text?: string;
  photo?: { file_id: string; file_size?: number; width: number; height: number }[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}
export interface TgUpdate { update_id: number; message?: TgMessage }

export interface TelegramApi {
  getMe(): Promise<{ username: string }>;
  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<void>;
  /** The file's bytes; throws UploadError('too_large') above the upload limit. */
  download(fileId: string): Promise<Buffer>;
}

/** A failed Bot API call. The message is Telegram's description or a short cause; never a URL or the token. */
export class TelegramError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'TelegramError'; }
}

const API = 'https://api.telegram.org';

export function telegramApi(token: string, fetchFn: typeof fetch = fetch): TelegramApi {
  async function call<T>(method: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
    let res: Response;
    try {
      res = await fetchFn(`${API}/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new TelegramError('telegram unreachable');
    }
    const data = await res.json().catch(() => null) as { ok?: boolean; result?: T; description?: string } | null;
    if (!res.ok || !data?.ok) throw new TelegramError(`telegram: ${data?.description ?? `http ${res.status}`}`, res.status);
    return data.result as T;
  }
  return {
    getMe: async () => ({ username: (await call<{ username?: string }>('getMe', {})).username ?? '' }),
    getUpdates: (offset, timeoutSec) =>
      call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, (timeoutSec + 10) * 1000),
    sendMessage: async (chatId, text) => {
      await call('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
    },
    download: async (fileId) => {
      const f = await call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId });
      if (!f.file_path) throw new TelegramError('telegram: file not available');
      if ((f.file_size ?? 0) > MAX_UPLOAD_BYTES) throw new UploadError('too_large');
      let res: Response;
      try {
        res = await fetchFn(`${API}/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(60_000) });
      } catch {
        throw new TelegramError('telegram unreachable');
      }
      if (!res.ok) throw new TelegramError(`telegram: file download failed (http ${res.status})`, res.status);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > MAX_UPLOAD_BYTES) throw new UploadError('too_large');
      return data;
    },
  };
}

/** Who the configured bot is (read-only). Throws when no token is stored or Telegram rejects it. */
export async function telegramBotInfo(): Promise<{ username: string }> {
  const token = getSecret('telegram_bot_token');
  if (!token) throw new TelegramError('no bot token');
  return telegramApi(token).getMe();
}

// ---------- replies (Hebrew; the bot talks only to the owner) ----------

export const BOT_MSG = {
  help: 'אפשר לשלוח לי צילום של קבלה או קובץ PDF, ואני אקרא ואתייק אותו.',
  notLinked: (id: string) =>
    `הצ'אט הזה עדיין לא מחובר לאוסף החשבוניות.\nמזהה הצ'אט: ${id}\nכדי לחבר אותו: הגדרות ← בוט טלגרם ← להוסיף את המזהה.`,
  reading: 'קיבלתי, קורא את המסמך…',
  unsupported: 'אפשר לשלוח רק תמונה או קובץ PDF. תמונה שנשלחה כקובץ ולא נקראה: לשלוח אותה שוב כתמונה רגילה.',
  tooLarge: 'הקובץ גדול מדי (עד 15MB).',
  failed: 'משהו השתבש ולא הצלחתי לקלוט את המסמך. אפשר לנסות שוב.',
  duplicate: 'המסמך הזה כבר קיים במערכת.',
  // shared bot (hub) only
  linked: 'הצ\'אט מחובר. אפשר לשלוח לי צילום של קבלה או קובץ PDF.',
  badCode: 'קישור החיבור לא תקף או שפג תוקפו. אפשר ליצור קישור חדש בהגדרות האפליקציה.',
  sharedNotLinked: 'הצ\'אט הזה עדיין לא מחובר. כדי לחבר אותו: באפליקציה, הגדרות ← בוט טלגרם ← חיבור טלגרם.',
  unlinked: 'הצ\'אט נותק.',
};
const MSG = BOT_MSG;

const STATE_MSG: Record<Item['state'], string> = {
  queued: 'נקלט. הקריאה תושלם בריצה הבאה.',
  waiting_ai: 'נקלט. ה-AI לא זמין כרגע, הקריאה תושלם כשיחזור.',
  needs_attention: 'נקלט, אבל צריך בדיקה באפליקציה.',
  awaiting_vendor: 'נקלט. זה ספק חדש: צריך לסמן באפליקציה אם הוא עסקי או פרטי.',
  awaiting_backfill_approval: 'נקלט וממתין לאישור באפליקציה.',
  ready: 'נקלט ויתויק בריצה הבאה.',
  stored: 'תויק. השליחה להנהלת החשבונות תושלם בריצה הבאה.',
  done: 'נקלט ותויק.',
  ignored: 'הספק מסומן "להתעלם", המסמך לא נשמר.',
  dismissed: 'נראה שהמסמך הזה כבר קיים במערכת (אותו ספק ואותו מספר מסמך).',
};

const base = () => (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');
const link = (id: string) => (base() ? `\n${base()}/items/${id}` : '');

function describe(item: Item): string {
  const f = item.fields;
  const parts = [
    f?.vendorName,
    f?.total != null ? `${f.total.toFixed(2)} ${f.currency ?? ''}`.trim() : null,
    f?.issueDate ? f.issueDate.split('-').reverse().join('/') : null,
    f?.category,
  ].filter(Boolean);
  return parts.length ? `\n${parts.join(' · ')}` : '';
}

export function replyFor(item: Item): string {
  return `${STATE_MSG[item.state]}${describe(item)}${link(item.id)}`;
}

/** Document types the bot accepts when a file (not a photo) is sent. */
const DOC_MIME = new Set(['application/pdf', 'image/jpeg']);

/**
 * The file a message carries: a photo (its largest size) or a PDF/JPEG document. `refuse` is the reply for a
 * file the bot does not take; null when the message carries no file at all.
 */
export function pickFile(msg: TgMessage): { fileId: string; name: string } | { refuse: string } | null {
  const photo = msg.photo?.length ? msg.photo[msg.photo.length - 1] : undefined; // sizes ascend: the last is the largest
  const doc = msg.document;
  if (!photo && !doc) return null;
  if (doc && !DOC_MIME.has(doc.mime_type ?? '')) return { refuse: MSG.unsupported };
  const file = (photo ?? doc)!;
  if ((file.file_size ?? 0) > MAX_UPLOAD_BYTES) return { refuse: MSG.tooLarge };
  return { fileId: file.file_id, name: doc?.file_name ?? `telegram-${msg.message_id}` };
}

export interface BotContext {
  /** Pipeline deps, or null while Gmail/Dropbox are not connected (the upload then waits for the worker). */
  getDeps: () => Deps | null;
  now?: () => Date;
}

/**
 * Takes a document that arrived by chat into the pipeline and returns the reply for the chat. A problem with
 * the document itself (wrong type, too large, already there) is a reply, not an error.
 */
export async function intakeDocument(data: Buffer, name: string, ctx: BotContext): Promise<string> {
  let created: { id: string; duplicateOf?: string };
  try {
    created = createUpload('telegram', name, data, (ctx.now ?? (() => new Date()))());
  } catch (e) {
    if (e instanceof UploadError) return e.code === 'too_large' ? MSG.tooLarge : MSG.unsupported;
    throw e;
  }
  if (created.duplicateOf) {
    const orig = getItem(created.duplicateOf);
    return `${MSG.duplicate}${orig ? describe(orig) : ''}${link(created.duplicateOf)}`;
  }
  let item: Item;
  try {
    item = await runUpload(created.id, ctx.getDeps());
  } catch (e) {
    console.error('chat upload processing failed:', e instanceof Error ? e.message : 'error');
    item = getItem(created.id)!; // stored and queued: the worker picks it up
  }
  return replyFor(item);
}

/** Handles one update of the instance's own bot. Never throws for a problem with the message itself. */
export async function handleUpdate(api: TelegramApi, update: TgUpdate, ctx: BotContext): Promise<void> {
  const msg = update.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  if (!getSettings().telegramChatIds.includes(chatId)) {
    await api.sendMessage(chatId, MSG.notLinked(chatId));
    return;
  }
  const file = pickFile(msg);
  if (!file) { await api.sendMessage(chatId, MSG.help); return; }
  if ('refuse' in file) { await api.sendMessage(chatId, file.refuse); return; }
  let data: Buffer;
  try {
    data = await api.download(file.fileId);
  } catch (e) {
    if (!(e instanceof UploadError)) console.error('telegram download failed:', e instanceof Error ? e.message : 'error');
    await api.sendMessage(chatId, e instanceof UploadError ? MSG.tooLarge : MSG.failed);
    return;
  }
  await api.sendMessage(chatId, MSG.reading).catch(() => { /* the result message follows anyway */ });
  let reply: string;
  try {
    reply = await intakeDocument(data, file.name, ctx);
  } catch (e) {
    console.error('telegram intake failed:', e instanceof Error ? e.message : 'error');
    reply = MSG.failed;
  }
  await api.sendMessage(chatId, reply);
}

export const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  t.unref();
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

export interface PollOptions {
  getToken: () => string | null;
  handle: (api: TelegramApi, update: TgUpdate) => Promise<void>;
  /** Injectable for tests; default builds the real client from the token. */
  makeApi?: (token: string) => TelegramApi;
  pollSeconds?: number;
  idleMs?: number;
}

/**
 * Long-polling loop over a bot's updates. It idles while there is no token and picks a new one up without a
 * restart. The read position is kept in memory per token: Telegram re-delivers anything not yet acknowledged,
 * and a document delivered twice is caught as a duplicate.
 */
export function pollTelegram(opts: PollOptions): { stop(): void; done: Promise<void> } {
  const abort = new AbortController();
  const makeApi = opts.makeApi ?? ((token: string) => telegramApi(token));
  const idleMs = opts.idleMs ?? 15_000;
  let lastError = '';

  async function loop(): Promise<void> {
    let token: string | null = null;
    let api: TelegramApi | null = null;
    let offset = 0;
    let failures = 0;
    while (!abort.signal.aborted) {
      let current: string | null = null;
      try { current = opts.getToken(); } catch { /* secret store unreadable: treat as not configured */ }
      if (!current) { token = null; api = null; await sleep(idleMs, abort.signal); continue; }
      if (current !== token || !api) { token = current; api = makeApi(current); offset = 0; failures = 0; }
      try {
        const updates = await api.getUpdates(offset, opts.pollSeconds ?? 25);
        failures = 0;
        lastError = '';
        for (const u of updates) {
          if (abort.signal.aborted) return;
          try {
            await opts.handle(api, u);
          } catch (e) {
            console.error('telegram update failed:', e instanceof Error ? e.message : 'error');
          }
          offset = u.update_id + 1;
        }
      } catch (e) {
        const m = e instanceof Error ? e.message : 'error';
        if (m !== lastError) { console.error('telegram bot:', m); lastError = m; } // once per distinct problem
        failures++;
        await sleep(Math.min(idleMs * 2 ** Math.min(failures, 4), 5 * 60_000), abort.signal);
      }
    }
  }

  const done = loop().catch((e) => { console.error('telegram bot stopped:', e instanceof Error ? e.message : 'error'); });
  return { stop: () => abort.abort(), done };
}

export interface BotOptions extends Partial<Omit<PollOptions, 'handle'>> { now?: () => Date }

/** The instance's own bot (token saved in Settings): only chats on the allowed list are served. */
export function startTelegramBot(getDeps: () => Deps | null, opts: BotOptions = {}): { stop(): void; done: Promise<void> } {
  return pollTelegram({
    ...opts,
    getToken: opts.getToken ?? (() => getSecret('telegram_bot_token')),
    handle: (api, u) => handleUpdate(api, u, { getDeps, now: opts.now }),
  });
}
