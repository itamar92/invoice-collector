import crypto from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, ZodError } from 'zod';
import { getDb } from '../db.js';
import {
  BOT_MSG, pickFile, pollTelegram, telegramApi, TelegramError, type TelegramApi, type TgUpdate,
} from '../sources/telegram.js';
import { UploadError } from '../sources/upload.js';

/**
 * Shared Telegram bot ("hub"): one bot serves many instances of this app, so their owners need no bot of their
 * own. An instance registers, asks for a pairing link (t.me/<bot>?start=<code>), and once its owner presses
 * Start in that chat, every receipt sent there is handed to that instance.
 *
 * The hub keeps no document: it stores Telegram's file id and fetches the bytes from Telegram only when the
 * owning instance asks for them. Instances long-poll the hub, so they need no public address.
 * Enabled by RELAY_BOT_TOKEN (see server.ts); RELAY_INVITE_KEY limits who may register.
 */

export interface HubOptions {
  token: string;
  /** When set, registering an instance requires this key. */
  inviteKey?: string;
  /** Injectable for tests; default is the real Bot API client for `token`. */
  api?: TelegramApi;
  now?: () => Date;
}

const PAIR_CODE_MS = 15 * 60_000;
const UPDATE_KEEP_MS = 7 * 24 * 60 * 60_000;
const MAX_WAIT_SEC = 30;
const REGISTRATIONS_PER_HOUR = 10;

const sha256hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a: string, b: string) => crypto.timingSafeEqual(Buffer.from(sha256hex(a)), Buffer.from(sha256hex(b)));

type Tenant = { id: string };
const tenantOf = (res: Response) => res.locals.tenant as Tenant;

export function createHub(opts: HubOptions) {
  const api = opts.api ?? telegramApi(opts.token);
  const clock = opts.now ?? (() => new Date());
  /** Instances waiting in a long poll, woken when a document arrives for them. */
  const waiters = new Map<string, Set<() => void>>();
  const registrations = new Map<string, number[]>();
  let botName: string | null = null;

  async function botUsername(): Promise<string> {
    botName ??= (await api.getMe()).username || null;
    if (!botName) throw new TelegramError('telegram: bot has no username');
    return botName;
  }

  const wake = (tenantId: string) => { for (const w of waiters.get(tenantId) ?? []) w(); };
  const pending = (tenantId: string) => getDb().prepare(
    'SELECT id, file_name AS fileName FROM relay_updates WHERE tenant_id = ? ORDER BY id LIMIT 5')
    .all(tenantId) as { id: number; fileName: string | null }[];

  // ---------- Telegram side ----------

  async function handle(update: TgUpdate): Promise<void> {
    const msg = update.message;
    if (!msg) return;
    const db = getDb();
    const chatId = String(msg.chat.id);
    const text = (msg.text ?? '').trim();
    const now = clock();

    const start = /^\/start(?:@\w+)?\s+([\w-]{8,64})$/.exec(text);
    if (start) {
      const row = db.prepare('SELECT tenant_id FROM relay_pair_codes WHERE code = ? AND expires_at > ?')
        .get(start[1], now.getTime()) as { tenant_id: string } | undefined;
      if (!row) { await api.sendMessage(chatId, BOT_MSG.badCode); return; }
      const name = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.title || msg.chat.username || null;
      db.transaction(() => {
        db.prepare('DELETE FROM relay_pair_codes WHERE code = ?').run(start[1]); // one use
        db.prepare(`INSERT INTO relay_chats (chat_id, tenant_id, name, linked_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT(chat_id) DO UPDATE SET tenant_id = excluded.tenant_id, name = excluded.name, linked_at = excluded.linked_at`)
          .run(chatId, row.tenant_id, name?.slice(0, 100) ?? null, now.toISOString());
      })();
      await api.sendMessage(chatId, BOT_MSG.linked);
      return;
    }

    const chat = db.prepare('SELECT tenant_id FROM relay_chats WHERE chat_id = ?').get(chatId) as { tenant_id: string } | undefined;
    if (!chat) { await api.sendMessage(chatId, BOT_MSG.sharedNotLinked); return; }
    if (/^\/stop(?:@\w+)?$/.test(text)) {
      db.prepare('DELETE FROM relay_chats WHERE chat_id = ?').run(chatId);
      await api.sendMessage(chatId, BOT_MSG.unlinked);
      return;
    }
    const file = pickFile(msg);
    if (!file) { await api.sendMessage(chatId, BOT_MSG.help); return; }
    if ('refuse' in file) { await api.sendMessage(chatId, file.refuse); return; }
    db.transaction(() => {
      db.prepare('DELETE FROM relay_updates WHERE created_at < ?').run(new Date(now.getTime() - UPDATE_KEEP_MS).toISOString());
      db.prepare('DELETE FROM relay_pair_codes WHERE expires_at <= ?').run(now.getTime());
      db.prepare('INSERT INTO relay_updates (tenant_id, chat_id, file_id, file_name, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(chat.tenant_id, chatId, file.fileId, file.name.slice(0, 200), now.toISOString());
    })();
    wake(chat.tenant_id);
    await api.sendMessage(chatId, BOT_MSG.reading);
  }

  // ---------- instance side (HTTP) ----------

  const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown): RequestHandler =>
    (req, res, next) => { Promise.resolve().then(() => fn(req, res)).catch(next); };
  const fail = (res: Response, status: number, error: string) => { res.status(status).json({ error }); };

  /** Bearer `<tenant id>.<secret>`; only the secret's hash is stored. */
  const requireTenant: RequestHandler = (req, res, next) => {
    const m = /^Bearer ([0-9a-f-]{36})\.([\w-]{20,100})$/.exec(req.headers.authorization ?? '');
    const row = m ? getDb().prepare('SELECT secret_hash FROM relay_tenants WHERE id = ?').get(m[1]) as { secret_hash: string } | undefined : undefined;
    if (!m || !row || !crypto.timingSafeEqual(Buffer.from(sha256hex(m[2])), Buffer.from(row.secret_hash))) {
      fail(res, 401, 'unauthorized');
      return;
    }
    getDb().prepare('UPDATE relay_tenants SET last_seen_at = ? WHERE id = ?').run(clock().toISOString(), m[1]);
    res.locals.tenant = { id: m[1] } satisfies Tenant;
    next();
  };

  const router = express.Router();

  router.post('/register', wrap((req, res) => {
    const { invite } = z.object({ invite: z.string().max(200).optional() }).parse(req.body ?? {});
    if (opts.inviteKey && !(invite && safeEqual(invite, opts.inviteKey))) return fail(res, 403, 'invite_required');
    const ip = req.ip ?? 'unknown';
    const t = clock().getTime();
    const recent = (registrations.get(ip) ?? []).filter((x) => t - x < 60 * 60_000);
    if (recent.length >= REGISTRATIONS_PER_HOUR) return fail(res, 429, 'too_many_attempts');
    registrations.set(ip, [...recent, t]);
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url');
    getDb().prepare('INSERT INTO relay_tenants (id, secret_hash, created_at) VALUES (?, ?, ?)')
      .run(id, sha256hex(secret), clock().toISOString());
    res.status(201).json({ auth: `${id}.${secret}` });
  }));

  router.post('/pair', requireTenant, wrap(async (_req, res) => {
    let username: string;
    try { username = await botUsername(); } catch { return fail(res, 502, 'telegram_unavailable'); }
    const code = crypto.randomBytes(18).toString('base64url');
    const expiresAt = clock().getTime() + PAIR_CODE_MS;
    getDb().prepare('INSERT INTO relay_pair_codes (code, tenant_id, expires_at) VALUES (?, ?, ?)').run(code, tenantOf(res).id, expiresAt);
    res.json({ url: `https://t.me/${username}?start=${code}`, expiresAt: new Date(expiresAt).toISOString() });
  }));

  router.get('/status', requireTenant, wrap(async (_req, res) => {
    let username: string | null = null;
    try { username = await botUsername(); } catch { /* Telegram down: the list below is still true */ }
    const chats = getDb().prepare(
      'SELECT chat_id AS id, name, linked_at AS linkedAt FROM relay_chats WHERE tenant_id = ? ORDER BY linked_at').all(tenantOf(res).id);
    res.json({ botUsername: username, chats });
  }));

  router.delete('/chats/:id', requireTenant, wrap((req, res) => {
    const r = getDb().prepare('DELETE FROM relay_chats WHERE chat_id = ? AND tenant_id = ?').run(String(req.params.id), tenantOf(res).id);
    if (r.changes === 0) return fail(res, 404, 'not_found');
    res.json({ ok: true });
  }));

  // Long poll: answers at once when documents wait, else when one arrives or `wait` seconds pass.
  router.get('/updates', requireTenant, wrap(async (req, res) => {
    const { wait } = z.object({ wait: z.coerce.number().int().min(0).max(MAX_WAIT_SEC).default(0) }).parse(req.query);
    const id = tenantOf(res).id;
    let updates = pending(id);
    if (updates.length === 0 && wait > 0) {
      await new Promise<void>((resolve) => {
        const set = waiters.get(id) ?? new Set();
        waiters.set(id, set);
        const done = () => { clearTimeout(timer); set.delete(done); if (set.size === 0) waiters.delete(id); resolve(); };
        const timer = setTimeout(done, wait * 1000);
        set.add(done);
        req.on('close', done);
      });
      updates = pending(id);
    }
    res.json({ updates });
  }));

  const ownUpdate = (req: Request, res: Response) => getDb().prepare(
    'SELECT id, chat_id, file_id FROM relay_updates WHERE id = ? AND tenant_id = ?')
    .get(Number(req.params.id) || 0, tenantOf(res).id) as { id: number; chat_id: string; file_id: string } | undefined;

  router.get('/updates/:id/file', requireTenant, wrap(async (req, res) => {
    const u = ownUpdate(req, res);
    if (!u) return fail(res, 404, 'not_found');
    try {
      res.type('application/octet-stream').send(await api.download(u.file_id));
    } catch (e) {
      if (e instanceof UploadError) return fail(res, 413, 'too_large');
      if (e instanceof TelegramError) return fail(res, e.status === 400 ? 410 : 502, e.status === 400 ? 'file_gone' : 'telegram_unavailable');
      throw e;
    }
  }));

  // The instance is finished with the document: forget it and pass its answer on to the chat.
  router.post('/updates/:id/done', requireTenant, wrap(async (req, res) => {
    const { reply } = z.object({ reply: z.string().max(1500).optional() }).parse(req.body ?? {});
    const u = ownUpdate(req, res);
    if (!u) return fail(res, 404, 'not_found');
    getDb().prepare('DELETE FROM relay_updates WHERE id = ?').run(u.id);
    if (reply) await api.sendMessage(u.chat_id, reply).catch(() => { /* the document is in; only the note is lost */ });
    res.json({ ok: true });
  }));

  router.use((_req, res) => { fail(res, 404, 'not_found'); });
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return fail(res, 400, 'invalid_request');
    console.error('relay hub error:', err instanceof Error ? err.message : 'error');
    fail(res, 500, 'internal_error');
  });

  return {
    router,
    handle,
    /** Starts reading the shared bot's messages. */
    start: () => pollTelegram({ getToken: () => opts.token, makeApi: () => api, handle: (_api, u) => handle(u) }),
  };
}
